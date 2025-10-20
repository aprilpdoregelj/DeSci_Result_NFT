pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract ClinicalTrialResultNFT_FHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        bool isOpen;
        uint256 totalEncryptedResults;
        euint32 encryptedSumOfResults;
    }
    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused();
    event ContractUnpaused();
    event CooldownSecondsUpdated(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event EncryptedResultSubmitted(address indexed provider, uint256 indexed batchId, euint32 encryptedResult);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 decryptedSum);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error AlreadyInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionRequestCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        cooldownSeconds = 60; // Default cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused();
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsUpdated(oldCooldownSeconds, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        Batch storage batch = batches[currentBatchId];
        batch.isOpen = true;
        batch.totalEncryptedResults = 0;
        // euint32 will be initialized by FHE.asEuint32 in the first submission
        // or explicitly here if preferred, though not strictly necessary for FHE.add
        // batch.encryptedSumOfResults = FHE.asEuint32(0); // Example, but FHE.add handles uninitialized
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batches[currentBatchId].isOpen) revert BatchNotOpen();
        batches[currentBatchId].isOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitEncryptedResult(euint32 encryptedResult) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batches[currentBatchId].isOpen) revert BatchNotOpen();

        lastSubmissionTime[msg.sender] = block.timestamp;

        Batch storage batch = batches[currentBatchId];
        if (!FHE.isInitialized(batch.encryptedSumOfResults)) {
            batch.encryptedSumOfResults = encryptedResult; // Initialize with the first result
        } else {
            batch.encryptedSumOfResults = FHE.add(batch.encryptedSumOfResults, encryptedResult);
        }
        batch.totalEncryptedResults++;

        emit EncryptedResultSubmitted(msg.sender, currentBatchId, encryptedResult);
    }

    function requestBatchSumDecryption(uint256 batchId) external onlyProvider whenNotPaused checkDecryptionRequestCooldown {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatch();
        if (batches[batchId].totalEncryptedResults == 0) revert InvalidBatch(); // No results to sum

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 encryptedSum = batches[batchId].encryptedSumOfResults;
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(encryptedSum);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        // Security: Replay protection ensures a callback for a given requestId is processed only once.

        DecryptionContext memory ctx = decryptionContexts[requestId];
        Batch storage batch = batches[ctx.batchId];

        // Security: State verification ensures that the contract state (specifically, the ciphertexts
        // that were intended for decryption) has not changed between the request and the callback.
        // This prevents scenarios where an attacker might alter the data after a decryption request
        // is made but before it's processed, leading to inconsistent or maliciously influenced results.
        bytes32[] memory currentCts = new bytes32[](1);
        currentCts[0] = FHE.toBytes32(batch.encryptedSumOfResults);
        bytes32 currentStateHash = _hashCiphertexts(currentCts);

        if (currentStateHash != ctx.stateHash) revert StateMismatch();

        // Security: Proof verification ensures that the cleartexts were indeed decrypted by a
        // legitimate FHE decryption key holder (e.g., Zama's service) and that the decryption
        // corresponds to the ciphertexts originally submitted for decryption.
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        (uint256 decryptedSum) = abi.decode(cleartexts, (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, decryptedSum);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }
}