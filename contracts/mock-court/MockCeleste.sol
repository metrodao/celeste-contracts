pragma solidity ^0.5.8;

import "../arbitration/IArbitrator.sol";

contract MockCeleste is IArbitrator {

    // Note that Aragon Court treats the possible outcomes as arbitrary numbers, leaving the Arbitrable (us) to define how to understand them.
    // Some outcomes [0, 1, and 2] are reserved by Aragon Court: "missing", "leaked", and "refused", respectively.
    // This Arbitrable introduces the concept of the challenger/submitter (a binary outcome) as 3/4.
    // Note that Aragon Court emits the lowest outcome in the event of a tie, and so for us, we prefer the challenger.
    uint256 public constant DISPUTES_RULING_CHALLENGER = 3;
    uint256 public constant DISPUTES_RULING_SUBMITTER = 4;
    uint256 public constant DISPUTES_NOT_RULED = 0;

    enum Outcome {
        NOT_DISPUTED,
        DISPUTED,
        DISPUTES_RULING_CHALLENGER,
        DISPUTES_RULING_SUBMITTER
    }

    struct Dispute {
        address subject;
        Outcome outcome;
    }

    uint256 public currentId;
    mapping(uint256 => Dispute) public disputes;
    address public owner;
    mapping(address => bool) public arbitrators;

    modifier onlyOwner {
        require(msg.sender == owner, "ERR:NOT_OWNER");
        _;
    }

    modifier onlyArbitrator {
        require(arbitrators[msg.sender] == true, "ERR:NOT_ARBITRATOR");
        _;
    }

    constructor() public {
        owner = msg.sender;
        arbitrators[msg.sender] = true;
    }

    function setOwner(address _owner) public onlyOwner {
        owner = _owner;
    }

    function addArbitrator(address _arbitrator) public onlyOwner {
        arbitrators[_arbitrator] = true;
    }

    function revokeArbitrator(address _arbitrator) public onlyOwner {
        require(arbitrators[_arbitrator] == true, "ERR:SHOULD_BE_ARBITRATOR");
        arbitrators[_arbitrator] = false;
    }

    /**
    * @dev Create a dispute over the Arbitrable sender with a number of possible rulings
    * @param _possibleRulings Number of possible rulings allowed for the dispute
    * @param _metadata Optional metadata that can be used to provide additional information on the dispute to be created
    * @return Dispute identification number
    */
    function createDispute(uint256 _possibleRulings, bytes calldata _metadata) external returns (uint256) {
        uint256 disputeId = currentId;
        disputes[disputeId] = Dispute(msg.sender, Outcome.DISPUTED);
        currentId++;
        return disputeId;
    }

    function decideDispute(uint256 _disputeId, bool _acceptChallenge) external onlyArbitrator {
        Dispute storage dispute = disputes[_disputeId];
        require(dispute.outcome == Outcome.DISPUTED, "ERR:NOT_DISPUTED");
        dispute.outcome = _acceptChallenge ?
            Outcome.DISPUTES_RULING_CHALLENGER : Outcome.DISPUTES_RULING_SUBMITTER;
    }

    /**
    * @dev Submit evidence for a dispute
    * @param _disputeId Id of the dispute in the Protocol
    * @param _submitter Address of the account submitting the evidence
    * @param _evidence Data submitted for the evidence related to the dispute
    */
    function submitEvidence(uint256 _disputeId, address _submitter, bytes calldata _evidence) external {}

    /**
    * @dev Close the evidence period of a dispute
    * @param _disputeId Identification number of the dispute to close its evidence submitting period
    */
    function closeEvidencePeriod(uint256 _disputeId) external {}

    /**
    * @notice Rule dispute #`_disputeId` if ready
    * @param _disputeId Identification number of the dispute to be ruled
    * @return subject Arbitrable instance associated to the dispute
    * @return ruling Ruling number computed for the given dispute
    */
    function rule(uint256 _disputeId) external returns (address subject, uint256 ruling) {
        Dispute storage dispute = disputes[_disputeId];

        if (dispute.outcome == Outcome.DISPUTES_RULING_CHALLENGER) {
            return (dispute.subject, DISPUTES_RULING_CHALLENGER);
        } else if (dispute.outcome == Outcome.DISPUTES_RULING_SUBMITTER) {
            return (dispute.subject, DISPUTES_RULING_SUBMITTER);
        } else {
            return (address(0), DISPUTES_NOT_RULED);
        }
    }

    /**
    * @dev Tell the dispute fees information to create a dispute
    * @return recipient Address where the corresponding dispute fees must be transferred to
    * @return feeToken ERC20 token used for the fees
    * @return feeAmount Total amount of fees that must be allowed to the recipient
    */
    function getDisputeFees() external view returns (address recipient, ERC20 feeToken, uint256 feeAmount) {
        return (address(0), ERC20(0), 0);
    }
}
