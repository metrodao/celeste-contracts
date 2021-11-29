pragma solidity ^0.5.8;

import "../arbitration/IArbitrator.sol";

contract OwnableCeleste is IArbitrator {

    // Note that Aragon Court treats the possible outcomes as arbitrary numbers, leaving the Arbitrable (us) to define how to understand them.
    // Some outcomes [0, 1, and 2] are reserved by Aragon Court: "missing", "leaked", and "refused", respectively.
    // This Arbitrable introduces the concept of the challenger/submitter (a binary outcome) as 3/4.
    // Note that Aragon Court emits the lowest outcome in the event of a tie, and so for us, we prefer the challenger.
    uint256 private constant DISPUTES_NOT_RULED = 0;
    uint256 private constant DISPUTES_RULING_CHALLENGER = 3;
    uint256 private constant DISPUTES_RULING_SUBMITTER = 4;

    enum State {
        NOT_DISPUTED,
        DISPUTED,
        DISPUTES_NOT_RULED,
        DISPUTES_RULING_CHALLENGER,
        DISPUTES_RULING_SUBMITTER
    }

    struct Dispute {
        address subject;
        State state;
    }

    uint256 public currentId;
    address public owner;
    mapping(uint256 => Dispute) public disputes;

    modifier onlyOwner {
        require(msg.sender == owner, "ERR:NOT_OWNER");
        _;
    }

    constructor() public {
        owner = msg.sender;
    }

    function setOwner(address _owner) public onlyOwner {
        owner = _owner;
    }

    /**
    * @dev Create a dispute over the Arbitrable sender with a number of possible rulings
    * @param _possibleRulings Number of possible rulings allowed for the dispute
    * @param _metadata Optional metadata that can be used to provide additional information on the dispute to be created
    * @return Dispute identification number
    */
    function createDispute(uint256 _possibleRulings, bytes calldata _metadata) external returns (uint256) {
        uint256 disputeId = currentId;
        disputes[disputeId] = Dispute(msg.sender, State.DISPUTED);
        currentId++;
        return disputeId;
    }

    function decideDispute(uint256 _disputeId, State _state) external onlyOwner {
        require(_state != State.NOT_DISPUTED && _state != State.DISPUTED, "ERR:OUTCOME_NOT_ASSIGNABLE");

        Dispute storage dispute = disputes[_disputeId];
        require(dispute.state == State.DISPUTED, "ERR:NOT_DISPUTED");

        dispute.state = _state;
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

        if (dispute.state == State.DISPUTES_RULING_CHALLENGER) {
            return (dispute.subject, DISPUTES_RULING_CHALLENGER);
        } else if (dispute.state == State.DISPUTES_RULING_SUBMITTER) {
            return (dispute.subject, DISPUTES_RULING_SUBMITTER);
        } else if (dispute.state == State.DISPUTES_NOT_RULED) {
            return (dispute.subject, DISPUTES_NOT_RULED);
        } else {
            revert();
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
