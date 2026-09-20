// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * DoctorZet CRC Reserve Oracle
 *
 * Manual verified mode:
 * an authorized reporter publishes the verified BAC CRC reserve
 * and the agreed CRC/USD exchange rate.
 *
 * IMPORTANT:
 * This contract records a signed administrative attestation.
 * It does not connect to BAC by itself and does not prove the bank balance.
 */
contract CrcReserveOracle {
    address public owner;
    address public reporter;

    uint256 public crcReserveE6;
    uint256 public crcPerUsdE6;
    uint256 public updatedAt;

    event ReporterChanged(address indexed previousReporter, address indexed newReporter);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ReserveUpdated(
        address indexed reporter,
        uint256 crcReserveE6,
        uint256 crcPerUsdE6,
        uint256 updatedAt
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyReporter() {
        require(msg.sender == reporter, "NOT_REPORTER");
        _;
    }

    constructor(address reporter_) {
        require(block.chainid == 137, "POLYGON_MAINNET_ONLY");
        require(reporter_ != address(0), "ZERO_REPORTER");

        owner = msg.sender;
        reporter = reporter_;

        emit OwnershipTransferred(address(0), msg.sender);
        emit ReporterChanged(address(0), reporter_);
    }

    function updateReserve(
        uint256 newCrcReserveE6,
        uint256 newCrcPerUsdE6
    ) external onlyReporter {
        require(newCrcPerUsdE6 > 0, "BAD_RATE");

        crcReserveE6 = newCrcReserveE6;
        crcPerUsdE6 = newCrcPerUsdE6;
        updatedAt = block.timestamp;

        emit ReserveUpdated(
            msg.sender,
            newCrcReserveE6,
            newCrcPerUsdE6,
            block.timestamp
        );
    }

    function getReserve()
        external
        view
        returns (
            uint256 reserveE6,
            uint256 rateE6,
            uint256 timestamp
        )
    {
        return (crcReserveE6, crcPerUsdE6, updatedAt);
    }

    function setReporter(address newReporter) external onlyOwner {
        require(newReporter != address(0), "ZERO_REPORTER");

        address old = reporter;
        reporter = newReporter;

        emit ReporterChanged(old, newReporter);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");

        address old = owner;
        owner = newOwner;

        emit OwnershipTransferred(old, newOwner);
    }
}
