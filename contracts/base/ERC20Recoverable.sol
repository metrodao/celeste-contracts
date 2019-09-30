pragma solidity ^0.5.8;

import "./Governed.sol";
import "@aragon/os/contracts/lib/token/ERC20.sol";


contract ERC20Recoverable is Governed {
    string private constant ERROR_INSUFFICIENT_RECOVER_FUNDS = "GVD_INSUFFICIENT_RECOVER_FUNDS";
    string private constant ERROR_RECOVER_TOKEN_FUNDS_FAILED = "GVD_RECOVER_TOKEN_FUNDS_FAILED";

    event RecoverFunds(ERC20 token, address recipient, uint256 balance);

    constructor (address _governor) public Governed(_governor) {}

    function recoverFunds(ERC20 _token, address _to) external onlyGovernor {
        uint256 balance = _token.balanceOf(address(this));
        require(balance > 0, ERROR_INSUFFICIENT_RECOVER_FUNDS);
        require(_token.transfer(_to, balance), ERROR_RECOVER_TOKEN_FUNDS_FAILED);
        emit RecoverFunds(_token, _to, balance);
    }
}
