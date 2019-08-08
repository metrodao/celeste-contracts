pragma solidity ^0.4.24;

import "./ICRVotingOwner.sol";


interface ICRVoting {
    function init(ICRVotingOwner owner) external;
    function getOwner() external view returns (address);
    function create(uint256 votingId, uint8 possibleOutcomes) external;
    function getWinningOutcome(uint256 votingId) external view returns (uint8);
    function getWinningOutcomeTally(uint256 votingId) external view returns (uint256);
    function getOutcomeTally(uint256 votingId, uint8 outcome) external view returns (uint256);
    function isValidOutcome(uint256 votingId, uint8 outcome) external view returns (bool);
    function getVoterOutcome(uint256 votingId, address voter) external view returns (uint8);
    function isWinningVoter(uint256 votingId, address voter) external view returns (bool);
    function getLosingVoters(uint256 votingId, address[] voters) external view returns (bool[]);
}
