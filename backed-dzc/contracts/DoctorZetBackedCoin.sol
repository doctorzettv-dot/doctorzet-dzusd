// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ICrcReserveOracle {
    function getReserve()
        external
        view
        returns (
            uint256 crcReserveE6,
            uint256 crcPerUsdE6,
            uint256 updatedAt
        );
}

/**
 * DoctorZet Backed Coin (DZC)
 * Polygon PoS mainnet
 *
 * Accounting target:
 *   1 DZC = US$1 equivalent
 *
 * Reserves counted:
 *   1) Native USDC physically held by this contract.
 *   2) Verified CRC bank reserve reported by CrcReserveOracle.
 *
 * Admin minting is reserve-limited:
 * total DZC after mint may not exceed adjusted reserve value.
 */
contract DoctorZetBackedCoin {
    string public constant name = "DoctorZet Backed Coin";
    string public constant symbol = "DZC";
    uint8 public constant decimals = 6;

    // Native USDC on Polygon PoS.
    address public constant USDC =
        0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;

    uint256 public constant ORACLE_MAX_AGE = 6 hours;

    address public admin;
    address public payoutOperator;
    ICrcReserveOracle public crcOracle;

    uint256 public totalSupply;
    bool public paused;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    struct CrcRedemption {
        address owner;
        uint256 dzcAmountE6;
        uint256 crcAmountE6;
        bool completed;
        bool cancelled;
    }

    uint256 public nextRedemptionId = 1;
    mapping(uint256 => CrcRedemption) public crcRedemptions;

    // Protects reserve accounting between a completed bank payout
    // and the next oracle update that reflects the lower bank balance.
    uint256 public crcPayoutsSinceOracleE6;
    uint256 public lastCrcPayoutAt;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event PayoutOperatorChanged(address indexed previousOperator, address indexed newOperator);
    event OracleChanged(address indexed previousOracle, address indexed newOracle);

    event AdminMint(
        address indexed admin,
        address indexed to,
        uint256 amountE6,
        uint256 adjustedReserveUsdE6
    );

    event RedeemedUSDC(
        address indexed account,
        uint256 dzcBurnedE6,
        uint256 usdcReturnedE6
    );

    event CrcRedemptionRequested(
        uint256 indexed requestId,
        address indexed owner,
        uint256 dzcAmountE6,
        uint256 crcAmountE6
    );

    event CrcRedemptionCompleted(
        uint256 indexed requestId,
        address indexed owner,
        uint256 dzcBurnedE6,
        uint256 crcPaidE6
    );

    event CrcRedemptionCancelled(
        uint256 indexed requestId,
        address indexed owner
    );

    event Paused(address indexed admin);
    event Unpaused(address indexed admin);

    modifier onlyAdmin() {
        require(msg.sender == admin, "NOT_ADMIN");
        _;
    }

    modifier onlyPayoutOperator() {
        require(msg.sender == payoutOperator, "NOT_PAYOUT_OPERATOR");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "PAUSED");
        _;
    }

    constructor(address oracle_, address payoutOperator_) {
        require(block.chainid == 137, "POLYGON_MAINNET_ONLY");
        require(oracle_ != address(0), "ZERO_ORACLE");
        require(payoutOperator_ != address(0), "ZERO_OPERATOR");

        admin = msg.sender;
        crcOracle = ICrcReserveOracle(oracle_);
        payoutOperator = payoutOperator_;

        emit AdminTransferred(address(0), msg.sender);
        emit OracleChanged(address(0), oracle_);
        emit PayoutOperatorChanged(address(0), payoutOperator_);
    }

    function transfer(address to, uint256 amount)
        external
        whenNotPaused
        returns (bool)
    {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount)
        external
        returns (bool)
    {
        require(spender != address(0), "ZERO_SPENDER");

        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external
        whenNotPaused
        returns (bool)
    {
        uint256 allowed = allowance[from][msg.sender];

        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ALLOWANCE");

            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }

            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }

        _transfer(from, to, amount);
        return true;
    }

    /**
     * Admin can mint large amounts, but only within reserve capacity.
     */
    function mint(address to, uint256 amountE6)
        external
        onlyAdmin
        returns (bool)
    {
        require(to != address(0), "ZERO_ADDRESS");
        require(amountE6 > 0, "ZERO_AMOUNT");

        uint256 reserves = reserveValueUsdE6();

        require(
            totalSupply + amountE6 <= reserves,
            "INSUFFICIENT_RESERVES"
        );

        totalSupply += amountE6;
        balanceOf[to] += amountE6;

        emit Transfer(address(0), to, amountE6);
        emit AdminMint(msg.sender, to, amountE6, reserves);

        return true;
    }

    /**
     * Redeems DZC into USDC immediately if this contract holds enough USDC.
     */
    function redeemUSDC(uint256 amountE6)
        external
        whenNotPaused
        returns (bool)
    {
        require(amountE6 > 0, "ZERO_AMOUNT");
        require(_usdcBalance() >= amountE6, "INSUFFICIENT_USDC");

        _burn(msg.sender, amountE6);
        _safeTransfer(USDC, msg.sender, amountE6);

        emit RedeemedUSDC(msg.sender, amountE6, amountE6);
        return true;
    }

    /**
     * Requests a CRC bank payout.
     * DZC is escrowed in the token contract until payout completion/cancellation.
     */
    function requestCrcRedemption(uint256 amountE6)
        external
        whenNotPaused
        returns (uint256 requestId)
    {
        require(amountE6 > 0, "ZERO_AMOUNT");

        (
            uint256 adjustedCrcReserveE6,
            uint256 crcPerUsdE6,
        ) = _adjustedCrcReserve();

        uint256 crcAmountE6 =
            (amountE6 * crcPerUsdE6) / 1e6;

        require(
            adjustedCrcReserveE6 >= crcAmountE6,
            "INSUFFICIENT_CRC_RESERVE"
        );

        _transfer(msg.sender, address(this), amountE6);

        requestId = nextRedemptionId++;

        crcRedemptions[requestId] = CrcRedemption({
            owner: msg.sender,
            dzcAmountE6: amountE6,
            crcAmountE6: crcAmountE6,
            completed: false,
            cancelled: false
        });

        emit CrcRedemptionRequested(
            requestId,
            msg.sender,
            amountE6,
            crcAmountE6
        );
    }

    /**
     * Payout operator calls this only after the real CRC bank payment is completed.
     */
    function completeCrcRedemption(uint256 requestId)
        external
        onlyPayoutOperator
    {
        CrcRedemption storage r = crcRedemptions[requestId];

        require(r.owner != address(0), "BAD_REQUEST");
        require(!r.completed && !r.cancelled, "FINALIZED");

        (, , uint256 oracleUpdatedAt) = _freshOracleData();

        // If the oracle has refreshed since the previous payout,
        // old payout adjustments are already reflected by the bank balance.
        if (oracleUpdatedAt > lastCrcPayoutAt) {
            crcPayoutsSinceOracleE6 = 0;
        }

        crcPayoutsSinceOracleE6 += r.crcAmountE6;
        lastCrcPayoutAt = block.timestamp;

        r.completed = true;

        _burn(address(this), r.dzcAmountE6);

        emit CrcRedemptionCompleted(
            requestId,
            r.owner,
            r.dzcAmountE6,
            r.crcAmountE6
        );
    }

    function cancelCrcRedemption(uint256 requestId)
        external
        onlyPayoutOperator
    {
        CrcRedemption storage r = crcRedemptions[requestId];

        require(r.owner != address(0), "BAD_REQUEST");
        require(!r.completed && !r.cancelled, "FINALIZED");

        r.cancelled = true;

        _transfer(address(this), r.owner, r.dzcAmountE6);

        emit CrcRedemptionCancelled(requestId, r.owner);
    }

    /**
     * Adjusted reserve value in USD, with 6 decimals.
     */
    function reserveValueUsdE6()
        public
        view
        returns (uint256)
    {
        uint256 usdcE6 = _usdcBalance();

        (
            uint256 adjustedCrcReserveE6,
            uint256 crcPerUsdE6,
        ) = _adjustedCrcReserve();

        uint256 crcValueUsdE6 =
            (adjustedCrcReserveE6 * 1e6) / crcPerUsdE6;

        return usdcE6 + crcValueUsdE6;
    }

    function mintCapacityE6()
        external
        view
        returns (uint256)
    {
        uint256 reserves = reserveValueUsdE6();

        if (reserves <= totalSupply) {
            return 0;
        }

        return reserves - totalSupply;
    }

    function fullyBacked()
        external
        view
        returns (bool)
    {
        return reserveValueUsdE6() >= totalSupply;
    }

    function reserveBreakdown()
        external
        view
        returns (
            uint256 usdcReserveE6,
            uint256 rawCrcReserveE6,
            uint256 adjustedCrcReserveE6,
            uint256 crcPerUsdE6,
            uint256 crcValueUsdE6,
            uint256 totalReserveUsdE6,
            uint256 oracleUpdatedAt
        )
    {
        usdcReserveE6 = _usdcBalance();

        (
            rawCrcReserveE6,
            crcPerUsdE6,
            oracleUpdatedAt
        ) = _freshOracleData();

        adjustedCrcReserveE6 = rawCrcReserveE6;

        if (
            oracleUpdatedAt <= lastCrcPayoutAt &&
            crcPayoutsSinceOracleE6 > 0
        ) {
            if (crcPayoutsSinceOracleE6 >= adjustedCrcReserveE6) {
                adjustedCrcReserveE6 = 0;
            } else {
                adjustedCrcReserveE6 -= crcPayoutsSinceOracleE6;
            }
        }

        crcValueUsdE6 =
            (adjustedCrcReserveE6 * 1e6) / crcPerUsdE6;

        totalReserveUsdE6 =
            usdcReserveE6 + crcValueUsdE6;
    }

    function setOracle(address newOracle)
        external
        onlyAdmin
    {
        require(newOracle != address(0), "ZERO_ORACLE");

        address old = address(crcOracle);
        crcOracle = ICrcReserveOracle(newOracle);

        emit OracleChanged(old, newOracle);
    }

    function setPayoutOperator(address newOperator)
        external
        onlyAdmin
    {
        require(newOperator != address(0), "ZERO_OPERATOR");

        address old = payoutOperator;
        payoutOperator = newOperator;

        emit PayoutOperatorChanged(old, newOperator);
    }

    function transferAdmin(address newAdmin)
        external
        onlyAdmin
    {
        require(newAdmin != address(0), "ZERO_ADMIN");

        address old = admin;
        admin = newAdmin;

        emit AdminTransferred(old, newAdmin);
    }

    function pause() external onlyAdmin {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyAdmin {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function _adjustedCrcReserve()
        internal
        view
        returns (
            uint256 adjustedCrcReserveE6,
            uint256 crcPerUsdE6,
            uint256 oracleUpdatedAt
        )
    {
        (
            uint256 rawCrcReserveE6,
            uint256 rateE6,
            uint256 updatedAt
        ) = _freshOracleData();

        adjustedCrcReserveE6 = rawCrcReserveE6;
        crcPerUsdE6 = rateE6;
        oracleUpdatedAt = updatedAt;

        if (
            updatedAt <= lastCrcPayoutAt &&
            crcPayoutsSinceOracleE6 > 0
        ) {
            if (crcPayoutsSinceOracleE6 >= adjustedCrcReserveE6) {
                adjustedCrcReserveE6 = 0;
            } else {
                adjustedCrcReserveE6 -= crcPayoutsSinceOracleE6;
            }
        }
    }

    function _freshOracleData()
        internal
        view
        returns (
            uint256 crcReserveE6,
            uint256 crcPerUsdE6,
            uint256 updatedAt
        )
    {
        (crcReserveE6, crcPerUsdE6, updatedAt) =
            crcOracle.getReserve();

        require(crcPerUsdE6 > 0, "BAD_FX_RATE");
        require(updatedAt > 0, "NO_ORACLE_DATA");
        require(block.timestamp >= updatedAt, "BAD_TIMESTAMP");
        require(
            block.timestamp - updatedAt <= ORACLE_MAX_AGE,
            "STALE_ORACLE"
        );
    }

    function _transfer(address from, address to, uint256 amount)
        internal
    {
        require(to != address(0), "ZERO_ADDRESS");

        uint256 bal = balanceOf[from];
        require(bal >= amount, "BALANCE");

        unchecked {
            balanceOf[from] = bal - amount;
        }

        balanceOf[to] += amount;

        emit Transfer(from, to, amount);
    }

    function _burn(address from, uint256 amount)
        internal
    {
        uint256 bal = balanceOf[from];
        require(bal >= amount, "BALANCE");

        unchecked {
            balanceOf[from] = bal - amount;
            totalSupply -= amount;
        }

        emit Transfer(from, address(0), amount);
    }

    function _usdcBalance()
        internal
        view
        returns (uint256 amount)
    {
        (bool ok, bytes memory data) =
            USDC.staticcall(
                abi.encodeWithSignature(
                    "balanceOf(address)",
                    address(this)
                )
            );

        require(ok && data.length >= 32, "USDC_BALANCE_FAILED");
        amount = abi.decode(data, (uint256));
    }

    function _safeTransfer(
        address token,
        address to,
        uint256 amount
    ) internal {
        (bool ok, bytes memory data) =
            token.call(
                abi.encodeWithSignature(
                    "transfer(address,uint256)",
                    to,
                    amount
                )
            );

        require(
            ok && (data.length == 0 || abi.decode(data, (bool))),
            "TOKEN_TRANSFER_FAILED"
        );
    }
}
