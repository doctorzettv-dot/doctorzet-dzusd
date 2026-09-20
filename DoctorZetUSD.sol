// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * DoctorZet USD Coin (DZUSD)
 * Polygon PoS Mainnet, chainId 137.
 *
 * Economic model:
 * 1 DZUSD is minted only after this contract receives 1 native USDC.
 * 1 DZUSD can be redeemed for 1 native USDC held by this contract.
 *
 * Native USDC on Polygon:
 * 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
 *
 * There is no owner mint function.
 */
contract DoctorZetUSD {
    string public constant name = "DoctorZet USD Coin";
    string public constant symbol = "DZUSD";
    uint8 public constant decimals = 6;

    address public constant USDC =
        0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;

    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 private _locked = 1;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposited(address indexed account, uint256 usdcAmount, uint256 dzusdMinted);
    event Redeemed(address indexed account, uint256 dzusdBurned, uint256 usdcReturned);

    modifier nonReentrant() {
        require(_locked == 1, "REENTRANCY");
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor() {
        require(block.chainid == 137, "POLYGON_MAINNET_ONLY");
    }

    function deposit(uint256 amount) external nonReentrant returns (bool) {
        require(amount > 0, "ZERO_AMOUNT");

        uint256 beforeBalance = _usdcBalance();
        _safeTransferFrom(USDC, msg.sender, address(this), amount);
        uint256 received = _usdcBalance() - beforeBalance;

        require(received == amount, "BAD_USDC_TRANSFER");

        _mint(msg.sender, received);
        emit Deposited(msg.sender, received, received);
        return true;
    }

    function redeem(uint256 amount) external nonReentrant returns (bool) {
        require(amount > 0, "ZERO_AMOUNT");

        _burn(msg.sender, amount);
        _safeTransfer(USDC, msg.sender, amount);

        emit Redeemed(msg.sender, amount, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        require(spender != address(0), "ZERO_SPENDER");
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        uint256 currentAllowance = allowance[from][msg.sender];

        if (currentAllowance != type(uint256).max) {
            require(currentAllowance >= amount, "ALLOWANCE");
            unchecked {
                allowance[from][msg.sender] = currentAllowance - amount;
            }
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }

        _transfer(from, to, amount);
        return true;
    }

    function reserveUSDC() external view returns (uint256) {
        return _usdcBalance();
    }

    function fullyBacked() external view returns (bool) {
        return _usdcBalance() >= totalSupply;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "ZERO_ADDRESS");

        uint256 fromBalance = balanceOf[from];
        require(fromBalance >= amount, "BALANCE");

        unchecked {
            balanceOf[from] = fromBalance - amount;
        }

        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        require(to != address(0), "ZERO_ADDRESS");

        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        uint256 fromBalance = balanceOf[from];
        require(fromBalance >= amount, "BALANCE");

        unchecked {
            balanceOf[from] = fromBalance - amount;
            totalSupply -= amount;
        }

        emit Transfer(from, address(0), amount);
    }

    function _usdcBalance() internal view returns (uint256 amount) {
        (bool ok, bytes memory data) = USDC.staticcall(
            abi.encodeWithSignature("balanceOf(address)", address(this))
        );

        require(ok && data.length >= 32, "USDC_BALANCE_FAILED");
        amount = abi.decode(data, (uint256));
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", to, amount)
        );

        require(
            ok && (data.length == 0 || abi.decode(data, (bool))),
            "USDC_TRANSFER_FAILED"
        );
    }

    function _safeTransferFrom(
        address token,
        address from,
        address to,
        uint256 amount
    ) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256)",
                from,
                to,
                amount
            )
        );

        require(
            ok && (data.length == 0 || abi.decode(data, (bool))),
            "USDC_TRANSFER_FROM_FAILED"
        );
    }
}
