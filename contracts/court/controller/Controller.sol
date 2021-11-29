pragma solidity ^0.5.8;

import "../../lib/os/IsContract.sol";

import "../clock/CourtClock.sol";
import "../config/CourtConfig.sol";


contract Controller is IsContract, CourtClock, CourtConfig {
    string private constant ERROR_SENDER_NOT_GOVERNOR = "CTR_SENDER_NOT_GOVERNOR";
    string private constant ERROR_INVALID_GOVERNOR_ADDRESS = "CTR_INVALID_GOVERNOR_ADDRESS";
    string private constant ERROR_IMPLEMENTATION_NOT_CONTRACT = "CTR_IMPLEMENTATION_NOT_CONTRACT";
    string private constant ERROR_INVALID_IMPLS_INPUT_LENGTH = "CTR_INVALID_IMPLS_INPUT_LENGTH";

    address private constant ZERO_ADDRESS = address(0);

    // DisputeManager module ID - keccak256(abi.encodePacked("DISPUTE_MANAGER"))
    bytes32 internal constant DISPUTE_MANAGER = 0x14a6c70f0f6d449c014c7bbc9e68e31e79e8474fb03b7194df83109a2d888ae6;

    // Treasury module ID - keccak256(abi.encodePacked("TREASURY"))
    bytes32 internal constant TREASURY = 0x06aa03964db1f7257357ef09714a5f0ca3633723df419e97015e0c7a3e83edb7;

    // Voting module ID - keccak256(abi.encodePacked("VOTING"))
    bytes32 internal constant VOTING = 0x7cbb12e82a6d63ff16fe43977f43e3e2b247ecd4e62c0e340da8800a48c67346;

    // JurorsRegistry module ID - keccak256(abi.encodePacked("JURORS_REGISTRY"))
    bytes32 internal constant JURORS_REGISTRY = 0x3b21d36b36308c830e6c4053fb40a3b6d79dde78947fbf6b0accd30720ab5370;

    // Subscriptions module ID - keccak256(abi.encodePacked("SUBSCRIPTIONS"))
    bytes32 internal constant SUBSCRIPTIONS = 0x2bfa3327fe52344390da94c32a346eeb1b65a8b583e4335a419b9471e88c1365;

    // BrightIDRegister module ID - keccak256(abi.encodePacked("BRIGHTID_REGISTER"))
    bytes32 internal constant BRIGHTID_REGISTER = 0xc8d8a5444a51ecc23e5091f18c4162834512a4bc5cae72c637db45c8c37b3329;

    /**
    * @dev Governor of the whole system. Set of three addresses to recover funds, change configuration settings and setup modules
    */
    struct Governor {
        address funds;      // This address can be unset at any time. It is allowed to recover funds from the ControlledRecoverable modules
        address config;     // This address is meant not to be unset. It is allowed to change the different configurations of the whole system
        address feesUpdater;// This is a second address that can update the config. It is expected to be used with a price oracle for updating fees
        address modules;    // This address can be unset at any time. It is allowed to plug/unplug modules from the system
    }

    // Governor addresses of the system
    Governor private governor;

    // List of modules registered for the system indexed by ID
    mapping (bytes32 => address) internal modules;

    event ModuleSet(bytes32 id, address addr);
    event FundsGovernorChanged(address previousGovernor, address currentGovernor);
    event ConfigGovernorChanged(address previousGovernor, address currentGovernor);
    event FeesUpdaterChanged(address previousFeesUpdater, address currentFeesUpdater);
    event ModulesGovernorChanged(address previousGovernor, address currentGovernor);

    /**
    * @dev Ensure the msg.sender is the funds governor
    */
    modifier onlyFundsGovernor {
        require(msg.sender == governor.funds, ERROR_SENDER_NOT_GOVERNOR);
        _;
    }

    /**
    * @dev Ensure the msg.sender is the config governor
    */
    modifier onlyConfigGovernor {
        require(msg.sender == governor.config, ERROR_SENDER_NOT_GOVERNOR);
        _;
    }

    /**
    * @dev Ensure the msg.sender is the config governor or the fees updater
    */
    modifier onlyConfigGovernorOrFeesUpdater {
        require(msg.sender == governor.config || msg.sender == governor.feesUpdater, ERROR_SENDER_NOT_GOVERNOR);
        _;
    }

    /**
    * @dev Ensure the msg.sender is the modules governor
    */
    modifier onlyModulesGovernor {
        require(msg.sender == governor.modules, ERROR_SENDER_NOT_GOVERNOR);
        _;
    }

    /**
    * @dev Constructor function
    * @param _termParams Array containing:
    *        0. _termDuration Duration in seconds per term
    *        1. _firstTermStartTime Timestamp in seconds when the court will open (to give time for juror on-boarding)
    * @param _governors Array containing:
    *        0. _fundsGovernor Address of the funds governor
    *        1. _configGovernor Address of the config governor
    *        2. _feesUpdater Address of the price feesUpdater
    *        3. _modulesGovernor Address of the modules governor
    * @param _feeToken Address of the token contract that is used to pay for fees
    * @param _fees Array containing:
    *        0. jurorFee Amount of fee tokens that is paid per juror per dispute
    *        1. draftFee Amount of fee tokens per juror to cover the drafting cost
    *        2. settleFee Amount of fee tokens per juror to cover round settlement cost
    * @param _maxRulingOptions Max number of selectable outcomes for each dispute
    * @param _roundParams Array containing durations of phases of a dispute and other params for rounds:
    *        0. evidenceTerms Max submitting evidence period duration in terms
    *        1. commitTerms Commit period duration in terms
    *        2. revealTerms Reveal period duration in terms
    *        3. appealTerms Appeal period duration in terms
    *        4. appealConfirmationTerms Appeal confirmation period duration in terms
    *        5. firstRoundJurorsNumber Number of jurors to be drafted for the first round of disputes
    *        6. appealStepFactor Increasing factor for the number of jurors of each round of a dispute
    *        7. maxRegularAppealRounds Number of regular appeal rounds before the final round is triggered
    *        8. finalRoundLockTerms Number of terms that a coherent juror in a final round is disallowed to withdraw (to prevent 51% attacks)
    * @param _pcts Array containing:
    *        0. penaltyPct Permyriad of min active tokens balance to be locked to each drafted jurors (‱ - 1/10,000)
    *        1. finalRoundReduction Permyriad of fee reduction for the last appeal round (‱ - 1/10,000)
    * @param _appealCollateralParams Array containing params for appeal collateral:
    *        0. appealCollateralFactor Permyriad multiple of dispute fees required to appeal a preliminary ruling
    *        1. appealConfirmCollateralFactor Permyriad multiple of dispute fees required to confirm appeal
    * @param _jurorsParams Array containing params for jurors:
    *        0. minActiveBalance Minimum amount of juror tokens that can be activated
    *        1. minMaxPctTotalSupply The min max percent of the total supply a juror can activate, applied for total supply active stake
    *        2. maxMaxPctTotalSupply The max max percent of the total supply a juror can activate, applied for 0 active stake
    *        3. feeTokenTotalSupply Set for networks that don't have access to the fee token's total supply, set to 0 for networks that do
    */
    constructor(
        uint64[2] memory _termParams,
        address[4] memory _governors,
        ERC20 _feeToken,
        uint256[3] memory _fees,
        uint8 _maxRulingOptions,
        uint64[9] memory _roundParams,
        uint16[2] memory _pcts,
        uint256[2] memory _appealCollateralParams,
        uint256[4] memory _jurorsParams
    )
        public
        CourtClock(_termParams, _feeToken)
        CourtConfig(_feeToken, _fees, _maxRulingOptions, _roundParams, _pcts, _appealCollateralParams, _jurorsParams)
    {
        _setFundsGovernor(_governors[0]);
        _setConfigGovernor(_governors[1]);
        _setFeesUpdater(_governors[2]);
        _setModulesGovernor(_governors[3]);
    }

    /**
    * @notice Change Court configuration params
    * @param _fromTermId Identification number of the term in which the config will be effective at
    * @param _feeToken Address of the token contract that is used to pay for fees
    * @param _fees Array containing:
    *        0. jurorFee Amount of fee tokens that is paid per juror per dispute
    *        1. draftFee Amount of fee tokens per juror to cover the drafting cost
    *        2. settleFee Amount of fee tokens per juror to cover round settlement cost
    * @param _maxRulingOptions Max number of selectable outcomes for each dispute
    * @param _roundParams Array containing durations of phases of a dispute and other params for rounds:
    *        0. evidenceTerms Max submitting evidence period duration in terms
    *        1. commitTerms Commit period duration in terms
    *        2. revealTerms Reveal period duration in terms
    *        3. appealTerms Appeal period duration in terms
    *        4. appealConfirmationTerms Appeal confirmation period duration in terms
    *        5. firstRoundJurorsNumber Number of jurors to be drafted for the first round of disputes
    *        6. appealStepFactor Increasing factor for the number of jurors of each round of a dispute
    *        7. maxRegularAppealRounds Number of regular appeal rounds before the final round is triggered
    *        8. finalRoundLockTerms Number of terms that a coherent juror in a final round is disallowed to withdraw (to prevent 51% attacks)
    * @param _pcts Array containing:
    *        0. penaltyPct Permyriad of min active tokens balance to be locked to each drafted jurors (‱ - 1/10,000)
    *        1. finalRoundReduction Permyriad of fee reduction for the last appeal round (‱ - 1/10,000)
    * @param _appealCollateralParams Array containing params for appeal collateral:
    *        0. appealCollateralFactor Permyriad multiple of dispute fees required to appeal a preliminary ruling
    *        1. appealConfirmCollateralFactor Permyriad multiple of dispute fees required to confirm appeal
    * @param _jurorsParams Array containing params for jurors:
    *        0. minActiveBalance Minimum amount of juror tokens that can be activated
    *        1. minMaxPctTotalSupply The min max percent of the total supply a juror can activate, applied for total supply active stake
    *        2. maxMaxPctTotalSupply The max max percent of the total supply a juror can activate, applied for 0 active stake
    *        3. feeTokenTotalSupply Set for networks that don't have access to the fee token's total supply, set to 0 for networks that do
    */
    function setConfig(
        uint64 _fromTermId,
        ERC20 _feeToken,
        uint256[3] calldata _fees,
        uint8 _maxRulingOptions,
        uint64[9] calldata _roundParams,
        uint16[2] calldata _pcts,
        uint256[2] calldata _appealCollateralParams,
        uint256[4] calldata _jurorsParams
    )
        external
        onlyConfigGovernorOrFeesUpdater
    {
        uint64 currentTermId = _ensureCurrentTerm();
        _setConfig(
            currentTermId,
            _fromTermId,
            _feeToken,
            _fees,
            _maxRulingOptions,
            _roundParams,
            _pcts,
            _appealCollateralParams,
            _jurorsParams
        );
    }

    /**
    * @notice Delay the Court start time to `_newFirstTermStartTime`
    * @param _newFirstTermStartTime New timestamp in seconds when the court will open
    */
    function delayStartTime(uint64 _newFirstTermStartTime) external onlyConfigGovernor {
        _delayStartTime(_newFirstTermStartTime);
    }

    /**
    * @notice Change funds governor address to `_newFundsGovernor`
    * @param _newFundsGovernor Address of the new funds governor to be set
    */
    function changeFundsGovernor(address _newFundsGovernor) external onlyFundsGovernor {
        require(_newFundsGovernor != ZERO_ADDRESS, ERROR_INVALID_GOVERNOR_ADDRESS);
        _setFundsGovernor(_newFundsGovernor);
    }

    /**
    * @notice Change config governor address to `_newConfigGovernor`
    * @param _newConfigGovernor Address of the new config governor to be set
    */
    function changeConfigGovernor(address _newConfigGovernor) external onlyConfigGovernor {
        require(_newConfigGovernor != ZERO_ADDRESS, ERROR_INVALID_GOVERNOR_ADDRESS);
        _setConfigGovernor(_newConfigGovernor);
    }

    /**
    * @notice Change fees updater to `_newFeesUpdater`
    * @param _newFeesUpdater Address of the new fees updater to be set
    */
    function changeFeesUpdater(address _newFeesUpdater) external onlyConfigGovernor {
        _setFeesUpdater(_newFeesUpdater);
    }

    /**
    * @notice Change modules governor address to `_newModulesGovernor`
    * @param _newModulesGovernor Address of the new governor to be set
    */
    function changeModulesGovernor(address _newModulesGovernor) external onlyModulesGovernor {
        require(_newModulesGovernor != ZERO_ADDRESS, ERROR_INVALID_GOVERNOR_ADDRESS);
        _setModulesGovernor(_newModulesGovernor);
    }

    /**
    * @notice Remove the funds governor. Set the funds governor to the zero address.
    * @dev This action cannot be rolled back, once the funds governor has been unset, funds cannot be recovered from recoverable modules anymore
    */
    function ejectFundsGovernor() external onlyFundsGovernor {
        _setFundsGovernor(ZERO_ADDRESS);
    }

    /**
    * @notice Remove the modules governor. Set the modules governor to the zero address.
    * @dev This action cannot be rolled back, once the modules governor has been unset, system modules cannot be changed anymore
    */
    function ejectModulesGovernor() external onlyModulesGovernor {
        _setModulesGovernor(ZERO_ADDRESS);
    }

    /**
    * @notice Set module `_id` to `_addr`
    * @param _id ID of the module to be set
    * @param _addr Address of the module to be set
    */
    function setModule(bytes32 _id, address _addr) external onlyModulesGovernor {
        _setModule(_id, _addr);
    }

    /**
    * @notice Set many modules at once
    * @param _ids List of ids of each module to be set
    * @param _addresses List of addressed of each the module to be set
    */
    function setModules(bytes32[] calldata _ids, address[] calldata _addresses) external onlyModulesGovernor {
        require(_ids.length == _addresses.length, ERROR_INVALID_IMPLS_INPUT_LENGTH);

        for (uint256 i = 0; i < _ids.length; i++) {
            _setModule(_ids[i], _addresses[i]);
        }
    }

    /**
    * @dev Tell the full Court configuration parameters at a certain term
    * @param _termId Identification number of the term querying the Court config of
    * @return token Address of the token used to pay for fees
    * @return fees Array containing:
    *         0. jurorFee Amount of fee tokens that is paid per juror per dispute
    *         1. draftFee Amount of fee tokens per juror to cover the drafting cost
    *         2. settleFee Amount of fee tokens per juror to cover round settlement cost
    * @return maxRulingOptions Max number of selectable outcomes for each dispute
    * @return roundParams Array containing durations of phases of a dispute and other params for rounds:
    *         0. evidenceTerms Max submitting evidence period duration in terms
    *         1. commitTerms Commit period duration in terms
    *         2. revealTerms Reveal period duration in terms
    *         3. appealTerms Appeal period duration in terms
    *         4. appealConfirmationTerms Appeal confirmation period duration in terms
    *         5. firstRoundJurorsNumber Number of jurors to be drafted for the first round of disputes
    *         6. appealStepFactor Increasing factor for the number of jurors of each round of a dispute
    *         7. maxRegularAppealRounds Number of regular appeal rounds before the final round is triggered
    *         8. finalRoundLockTerms Number of terms that a coherent juror in a final round is disallowed to withdraw (to prevent 51% attacks)
    * @return pcts Array containing:
    *         0. penaltyPct Permyriad of min active tokens balance to be locked for each drafted juror (‱ - 1/10,000)
    *         1. finalRoundReduction Permyriad of fee reduction for the last appeal round (‱ - 1/10,000)
    * @return appealCollateralParams Array containing params for appeal collateral:
    *         0. appealCollateralFactor Multiple of dispute fees required to appeal a preliminary ruling
    *         1. appealConfirmCollateralFactor Multiple of dispute fees required to confirm appeal
    * @return jurorsParams Array containing params for juror registry:
    *         0. minActiveBalance Minimum amount of juror tokens that can be activated
    *         1. minMaxPctTotalSupply The min max percent of the total supply a juror can activate, applied for total supply active stake
    *         2. maxMaxPctTotalSupply The max max percent of the total supply a juror can activate, applied for 0 active stake\
    *         3. feeTokenTotalSupply Set for networks that don't have access to the fee token's total supply, set to 0 for networks that do
    */
    function getConfig(uint64 _termId) external view
        returns (
            ERC20 feeToken,
            uint256[3] memory fees,
            uint8 maxRulingOptions,
            uint64[9] memory roundParams,
            uint16[2] memory pcts,
            uint256[2] memory appealCollateralParams,
            uint256[4] memory jurorsParams
        )
    {
        return _getConfig(_termId);
    }

    /**
    * @dev This function overrides one in the CourtClock, giving the CourtClock access to the config.
    */
    function _getConfig(uint64 _termId) internal view
        returns (
            ERC20 feeToken,
            uint256[3] memory fees,
            uint8 maxRulingOptions,
            uint64[9] memory roundParams,
            uint16[2] memory pcts,
            uint256[2] memory appealCollateralParams,
            uint256[4] memory jurorsParams
        )
    {
        uint64 lastEnsuredTermId = _lastEnsuredTermId();
        return _getConfigAt(_termId, lastEnsuredTermId);
    }

    /**
    * @dev Tell the draft config at a certain term
    * @param _termId Identification number of the term querying the draft config of
    * @return feeToken Address of the token used to pay for fees
    * @return draftFee Amount of fee tokens per juror to cover the drafting cost
    * @return penaltyPct Permyriad of min active tokens balance to be locked for each drafted juror (‱ - 1/10,000)
    */
    function getDraftConfig(uint64 _termId) external view returns (ERC20 feeToken, uint256 draftFee, uint16 penaltyPct) {
        uint64 lastEnsuredTermId = _lastEnsuredTermId();
        return _getDraftConfig(_termId, lastEnsuredTermId);
    }

    /**
    * @dev Tell the min active balance config at a certain term
    * @param _termId Identification number of the term querying the min active balance config of
    * @return Minimum amount of tokens jurors have to activate to participate in the Court
    */
    function getMinActiveBalance(uint64 _termId) external view returns (uint256) {
        uint64 lastEnsuredTermId = _lastEnsuredTermId();
        return _getMinActiveBalance(_termId, lastEnsuredTermId);
    }

    /**
    * @dev Tell the address of the funds governor
    * @return Address of the funds governor
    */
    function getFundsGovernor() external view returns (address) {
        return governor.funds;
    }

    /**
    * @dev Tell the address of the config governor
    * @return Address of the config governor
    */
    function getConfigGovernor() external view returns (address) {
        return governor.config;
    }

    /**
    * @dev Tell the address of the fees updater
    * @return Address of the fees updater
    */
    function getFeesUpdater() external view returns (address) {
        return governor.feesUpdater;
    }

    /**
    * @dev Tell the address of the modules governor
    * @return Address of the modules governor
    */
    function getModulesGovernor() external view returns (address) {
        return governor.modules;
    }

    /**
    * @dev Tell address of a module based on a given ID
    * @param _id ID of the module being queried
    * @return Address of the requested module
    */
    function getModule(bytes32 _id) external view returns (address) {
        return _getModule(_id);
    }

    /**
    * @dev Tell the address of the DisputeManager module
    * @return Address of the DisputeManager module
    */
    function getDisputeManager() external view returns (address) {
        return _getDisputeManager();
    }

    /**
    * @dev Tell the address of the Treasury module
    * @return Address of the Treasury module
    */
    function getTreasury() external view returns (address) {
        return _getModule(TREASURY);
    }

    /**
    * @dev Tell the address of the Voting module
    * @return Address of the Voting module
    */
    function getVoting() external view returns (address) {
        return _getModule(VOTING);
    }

    /**
    * @dev Tell the address of the JurorsRegistry module
    * @return Address of the JurorsRegistry module
    */
    function getJurorsRegistry() external view returns (address) {
        return _getModule(JURORS_REGISTRY);
    }

    /**
    * @dev Tell the address of the Subscriptions module
    * @return Address of the Subscriptions module
    */
    function getSubscriptions() external view returns (address) {
        return _getSubscriptions();
    }

    /**
    * @dev Tell the address of the BrightId register
    * @return Address of the BrightId register
    */
    function getBrightIdRegister() external view returns (address) {
        return _getBrightIdRegister();
    }

    /**
    * @dev Internal function to set the address of the funds governor
    * @param _newFundsGovernor Address of the new config governor to be set
    */
    function _setFundsGovernor(address _newFundsGovernor) internal {
        emit FundsGovernorChanged(governor.funds, _newFundsGovernor);
        governor.funds = _newFundsGovernor;
    }

    /**
    * @dev Internal function to set the address of the config governor
    * @param _newConfigGovernor Address of the new config governor to be set
    */
    function _setConfigGovernor(address _newConfigGovernor) internal {
        emit ConfigGovernorChanged(governor.config, _newConfigGovernor);
        governor.config = _newConfigGovernor;
    }

    /**
    * @dev Internal function to set the address of the fees updater
    * @param _newFeesUpdater Address of the new fees updater to be set
    */
    function _setFeesUpdater(address _newFeesUpdater) internal {
        emit FeesUpdaterChanged(governor.feesUpdater, _newFeesUpdater);
        governor.feesUpdater = _newFeesUpdater;
    }

    /**
    * @dev Internal function to set the address of the modules governor
    * @param _newModulesGovernor Address of the new modules governor to be set
    */
    function _setModulesGovernor(address _newModulesGovernor) internal {
        emit ModulesGovernorChanged(governor.modules, _newModulesGovernor);
        governor.modules = _newModulesGovernor;
    }

    /**
    * @dev Internal function to set a module
    * @param _id Id of the module to be set
    * @param _addr Address of the module to be set
    */
    function _setModule(bytes32 _id, address _addr) internal {
        require(isContract(_addr), ERROR_IMPLEMENTATION_NOT_CONTRACT);
        modules[_id] = _addr;
        emit ModuleSet(_id, _addr);
    }

    /**
    * @dev Internal function to notify when a term has been transitioned
    * @param _termId Identification number of the new current term that has been transitioned
    */
    function _onTermTransitioned(uint64 _termId) internal {
        _ensureTermConfig(_termId);
    }

    /**
    * @dev Internal function to tell the address of the DisputeManager module
    * @return Address of the DisputeManager module
    */
    function _getDisputeManager() internal view returns (address) {
        return _getModule(DISPUTE_MANAGER);
    }

    /**
    * @dev Internal function to tell the address of the Subscriptions module
    * @return Address of the Subscriptions module
    */
    function _getSubscriptions() internal view returns (address) {
        return _getModule(SUBSCRIPTIONS);
    }


    /**
    * @dev Internal function to tell the address of the BrightId register
    * @return Address of the BrightId register
    */
    function _getBrightIdRegister() internal view returns (address) {
        return _getModule(BRIGHTID_REGISTER);
    }

    /**
    * @dev Internal function to tell address of a module based on a given ID
    * @param _id ID of the module being queried
    * @return Address of the requested module
    */
    function _getModule(bytes32 _id) internal view returns (address) {
        return modules[_id];
    }
}
