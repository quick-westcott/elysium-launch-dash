// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * ElysiumDesk: an owner-only trading desk for Uniswap V4 pools on Elysium
 * (Ascend's hook pools and plain V4 pools alike), quoted in HYPE.
 *
 * Why it exists (11/5/2026). The fast trader 0x7ab6…4b20 on Ascend runs every
 * buy and sell through a private contract that talks to the PoolManager
 * directly: no router, no Permit2, no ERC-20 approvals, tokens kept inside the
 * contract between the two legs, 150–220k gas a trade. Our path through the
 * UniversalRouter needed two approvals per wallet per coin before the first
 * sell could go, and 560–700k gas. This is the same shape, built for us.
 *
 *   buy(key, hypeIn, minOut)   native HYPE held here → wrapped inside the
 *                              callback → swapped → the coin stays HERE.
 *   sell(key, amountIn, minOut) the coin → WHYPE → unwrapped → native HYPE
 *                              stays here. amountIn 0 = everything held.
 *   withdrawHype / withdrawToken   owner takes funds out.
 *
 * Settlement follows V4's unlock pattern: swap, then sync + transfer + settle
 * for what is owed, take for what is received. Exact-input only (negative
 * amountSpecified), limit price at the pool's edge, slippage by minOut.
 * The owner is the only caller of the two trade functions, and only the
 * PoolManager may call unlockCallback. No upgrade path, no delegatecall.
 */

type Currency is address;

struct PoolKey {
    Currency currency0;
    Currency currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(Currency currency) external;
    function settle() external payable returns (uint256);
    function take(Currency currency, address to, uint256 amount) external;
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
    function balanceOf(address) external view returns (uint256);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
}

contract ElysiumDesk {
    address public owner;                       // storage slot 0
    /// Elysium mainnet (99901): Uniswap V4 PoolManager and WHYPE, Ascend's published set (ascend-market.ts). Constants, not
    /// immutables, so the runtime bytecode can be simulated by code override before it is deployed.
    IPoolManager public constant poolManager = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    IWETH9 public constant whype = IWETH9(0xbA876237B0F021A6c6D852d6c26E107997cC5E81);

    /// MIN_SQRT_PRICE + 1 and MAX_SQRT_PRICE - 1 from v4-core TickMath: the swap may run to the pool's edge; minOut is the guard.
    uint160 private constant LIMIT_DOWN = 4295128740;
    uint160 private constant LIMIT_UP = 1461446703485210103287273052203988822378723970341;

    struct Order {
        PoolKey key;
        bool buy;
        uint256 amountIn;
        uint256 minOut;
    }

    event Traded(address indexed token, bool indexed buy, uint256 amountIn, uint256 amountOut);
    event OwnerChanged(address indexed previous, address indexed next);

    error NotOwner();
    error NotPoolManager();
    error Slippage(uint256 out, uint256 minOut);
    error NothingToSell();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {}

    function setOwner(address next) external onlyOwner {
        emit OwnerChanged(owner, next);
        owner = next;
    }

    /// The coin side of a HYPE pair.
    function tokenOf(PoolKey memory key) public view returns (address) {
        return Currency.unwrap(key.currency0) == address(whype) ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
    }

    /// Spend `hypeIn` of the HYPE held here on the coin; the coin stays here.
    function buy(PoolKey calldata key, uint256 hypeIn, uint256 minOut) external onlyOwner returns (uint256 out) {
        bytes memory r = poolManager.unlock(abi.encode(Order(key, true, hypeIn, minOut)));
        out = abi.decode(r, (uint256));
    }

    /// Sell `amountIn` of the coin held here (0 = all of it) for HYPE, kept here as native.
    function sell(PoolKey calldata key, uint256 amountIn, uint256 minOut) external onlyOwner returns (uint256 out) {
        if (amountIn == 0) amountIn = IERC20(tokenOf(key)).balanceOf(address(this));
        if (amountIn == 0) revert NothingToSell();
        bytes memory r = poolManager.unlock(abi.encode(Order(key, false, amountIn, minOut)));
        out = abi.decode(r, (uint256));
    }

    /// Only the PoolManager, only inside our own unlock.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Order memory o = abi.decode(data, (Order));

        bool whypeIs0 = Currency.unwrap(o.key.currency0) == address(whype);
        // The input currency is currency0 when buying with WHYPE-as-0, or selling the coin-as-0.
        bool zeroForOne = o.buy ? whypeIs0 : !whypeIs0;
        Currency cIn = zeroForOne ? o.key.currency0 : o.key.currency1;
        Currency cOut = zeroForOne ? o.key.currency1 : o.key.currency0;

        int256 delta = poolManager.swap(
            o.key,
            SwapParams({ zeroForOne: zeroForOne, amountSpecified: -int256(o.amountIn), sqrtPriceLimitX96: zeroForOne ? LIMIT_DOWN : LIMIT_UP }),
            ""
        );
        // BalanceDelta packs amount0 in the upper 128 bits and amount1 in the lower 128, both signed.
        int128 a0 = int128(delta >> 128);
        int128 a1 = int128(delta);
        int128 dIn = zeroForOne ? a0 : a1;
        int128 dOut = zeroForOne ? a1 : a0;
        uint256 owed = uint256(uint128(-dIn));
        uint256 out = uint256(uint128(dOut));
        if (out < o.minOut) revert Slippage(out, o.minOut);

        // Pay what is owed: native HYPE wrapped on the way in for a buy; the coin itself for a sell.
        if (o.buy) whype.deposit{value: owed}();
        poolManager.sync(cIn);
        _transfer(Currency.unwrap(cIn), address(poolManager), owed);
        poolManager.settle();

        // Take what was bought; a sell's WHYPE is unwrapped so the desk holds HYPE, never WHYPE.
        poolManager.take(cOut, address(this), out);
        if (!o.buy) whype.withdraw(out);

        emit Traded(tokenOf(o.key), o.buy, owed, out);
        return abi.encode(out);
    }

    function withdrawHype(address to, uint256 amount) external onlyOwner {
        uint256 v = amount == 0 ? address(this).balance : amount;
        (bool ok, ) = to.call{value: v}("");
        if (!ok) revert TransferFailed();
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        uint256 v = amount == 0 ? IERC20(token).balanceOf(address(this)) : amount;
        _transfer(token, to, v);
    }

    /// ERC-20 transfer that accepts both "returns bool" and "returns nothing" tokens.
    function _transfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}

/// Test-only: one call that buys then sells through a desk it owns, so the whole round trip can be simulated with eth_call.
contract DeskRoundTrip {
    function run(ElysiumDesk desk, PoolKey calldata key, uint256 hypeIn) external returns (uint256 bought, uint256 hypeBack, uint256 gasBuy, uint256 gasSell) {
        uint256 g = gasleft();
        bought = desk.buy(key, hypeIn, 0);
        gasBuy = g - gasleft();
        g = gasleft();
        hypeBack = desk.sell(key, 0, 0);
        gasSell = g - gasleft();
    }
}
