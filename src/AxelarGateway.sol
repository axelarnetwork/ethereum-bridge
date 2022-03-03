// SPDX-License-Identifier: MIT

pragma solidity 0.8.9;

import { IAxelarGateway } from './interfaces/IAxelarGateway.sol';
import { IERC20 } from './interfaces/IERC20.sol';

import { BurnableMintableCappedERC20 } from './BurnableMintableCappedERC20.sol';
import { DepositHandler } from './DepositHandler.sol';
import { AdminMultisigBase } from './AdminMultisigBase.sol';

abstract contract AxelarGateway is IAxelarGateway, AdminMultisigBase {
    enum Role {
        Admin,
        Owner,
        Operator
    }

    enum TokenType {
        InternalBurnable,
        InternalBurnableFrom,
        External
    }

    /// @dev Storage slot with the address of the current factory. `keccak256('eip1967.proxy.implementation') - 1`.
    bytes32 internal constant KEY_IMPLEMENTATION =
        bytes32(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc);

    // AUDIT: slot names should be prefixed with some standard string
    // AUDIT: constants should be literal and their derivation should be in comments
    bytes32 internal constant KEY_ALL_TOKENS_FROZEN = keccak256('all-tokens-frozen');

    bytes32 internal constant PREFIX_COMMAND_EXECUTED = keccak256('command-executed');
    bytes32 internal constant PREFIX_TOKEN_ADDRESS = keccak256('token-address');
    bytes32 internal constant PREFIX_TOKEN_TYPE = keccak256('token-type');
    bytes32 internal constant PREFIX_TOKEN_FROZEN = keccak256('token-frozen');
    bytes32 internal constant PREFIX_CONTRACT_CALL_APPROVED = keccak256('contract-call-approved');

    bytes32 internal constant SELECTOR_BURN_TOKEN = keccak256('burnToken');
    bytes32 internal constant SELECTOR_DEPLOY_TOKEN = keccak256('deployToken');
    bytes32 internal constant SELECTOR_MINT_TOKEN = keccak256('mintToken');
    bytes32 internal constant SELECTOR_MINT_TOKEN_AND_APPROVE_CONTRACT_CALL =
        keccak256('mintTokenAndApproveContractCall');
    bytes32 internal constant SELECTOR_APPROVE_CONTRACT_CALL = keccak256('approveContractCall');
    bytes32 internal constant SELECTOR_TRANSFER_OPERATORSHIP = keccak256('transferOperatorship');
    bytes32 internal constant SELECTOR_TRANSFER_OWNERSHIP = keccak256('transferOwnership');

    uint8 internal constant OLD_KEY_RETENTION = 16;

    modifier onlySelf() {
        require(msg.sender == address(this), 'NOT_SELF');

        _;
    }

    /***********\
    |* Getters *|
    \***********/

    function allTokensFrozen() public view override returns (bool) {
        return getBool(KEY_ALL_TOKENS_FROZEN);
    }

    function implementation() public view override returns (address) {
        return getAddress(KEY_IMPLEMENTATION);
    }

    function tokenAddresses(string memory symbol) public view override returns (address) {
        return getAddress(_getTokenAddressKey(symbol));
    }

    function tokenFrozen(string memory symbol) public view override returns (bool) {
        return getBool(_getFreezeTokenKey(symbol));
    }

    function isCommandExecuted(bytes32 commandId) public view override returns (bool) {
        return getBool(_getIsCommandExecutedKey(commandId));
    }

    function isContractCallApproved(address contractAddress, bytes32 payloadHash) public view override returns (bool) {
        return getBool(_getIsContractCallApprovedKey(contractAddress, payloadHash));
    }

    function isContractCallApprovedWithMint(address contractAddress, bytes32 payloadHash, address token, uint256 amount) public view override returns (bool) {
        return getBool(_getIsContractCallApprovedWithMintKey(contractAddress, payloadHash, token, amount));
    }

    /*******************\
    |* Admin Functions *|
    \*******************/

    function freezeToken(string memory symbol) external override onlyAdmin {
        _setBool(_getFreezeTokenKey(symbol), true);

        emit TokenFrozen(symbol);
    }

    function unfreezeToken(string memory symbol) external override onlyAdmin {
        _setBool(_getFreezeTokenKey(symbol), false);

        emit TokenUnfrozen(symbol);
    }

    function freezeAllTokens() external override onlyAdmin {
        _setBool(KEY_ALL_TOKENS_FROZEN, true);

        emit AllTokensFrozen();
    }

    function unfreezeAllTokens() external override onlyAdmin {
        _setBool(KEY_ALL_TOKENS_FROZEN, false);

        emit AllTokensUnfrozen();
    }

    function upgrade(
        address newImplementation,
        bytes32 newImplementationCodeHash,
        bytes calldata setupParams
    ) external override onlyAdmin {
        require(newImplementationCodeHash == newImplementation.codehash, 'INV_CODEHASH');

        emit Upgraded(newImplementation);

        // AUDIT: If `newImplementation.setup` performs `selfdestruct`, it will result in the loss of _this_ implementation (thereby losing the gateway)
        //        if `upgrade` is entered within the context of _this_ implementation itself.
        if (setupParams.length > 0) {
            (bool success, ) = newImplementation.delegatecall(
                abi.encodeWithSelector(IAxelarGateway.setup.selector, setupParams)
            );
            require(success, 'SETUP_FAILED');
        }

        _setImplementation(newImplementation);
    }

    /**********************\
    |* Internal Functions *|
    \**********************/

    function _deployToken(
        string memory name,
        string memory symbol,
        uint8 decimals,
        uint256 cap,
        address tokenAddress
    ) internal {
        // Ensure that this symbol has not been taken.
        require(tokenAddresses(symbol) == address(0), 'TOKEN_EXIST');

        if (tokenAddress == address(0)) {
            // If token address is no specified, it indicates a request to deploy one.
            bytes32 salt = keccak256(abi.encodePacked(symbol));
            tokenAddress = address(new BurnableMintableCappedERC20{ salt: salt }(name, symbol, decimals, cap));
            _setTokenType(symbol, TokenType.InternalBurnableFrom);
        } else {
            // If token address is specified, ensure that there is a contact at the specified addressed.
            require(tokenAddress.code.length != uint256(0), 'NOT_TOKEN');
            // Mark that this symbol is an external token, which is needed to differentiate between operations on mint and burn.
            _setTokenType(symbol, TokenType.External);
        }

        _setTokenAddress(symbol, tokenAddress);

        emit TokenDeployed(symbol, tokenAddress);
    }

    function _mintToken(
        string memory symbol,
        address account,
        uint256 amount
    ) internal {
        address tokenAddress = tokenAddresses(symbol);
        require(tokenAddress != address(0), 'TOKEN_NOT_EXIST');

        if (_getTokenType(symbol) == TokenType.External) {
            _callERC20Token(
                tokenAddress,
                abi.encodeWithSelector(IERC20.transfer.selector, account, amount),
                'MINT_FAIL'
            );
        } else {
            BurnableMintableCappedERC20(tokenAddress).mint(account, amount);
        }
    }

    function _burnToken(string memory symbol, bytes32 salt) internal {
        address tokenAddress = tokenAddresses(symbol);
        require(tokenAddress != address(0), 'TOKEN_NOT_EXIST');

        if (_getTokenType(symbol) == TokenType.External) {
            DepositHandler depositHandler = new DepositHandler{ salt: salt }();

            (bool success, bytes memory returnData) = depositHandler.execute(
                tokenAddress,
                abi.encodeWithSelector(
                    IERC20.transfer.selector,
                    address(this),
                    IERC20(tokenAddress).balanceOf(address(depositHandler))
                )
            );
            require(success && (returnData.length == uint256(0) || abi.decode(returnData, (bool))), 'BURN_FAIL');

            depositHandler.destroy(address(this));
        } else {
            BurnableMintableCappedERC20(tokenAddress).burn(salt);
        }
    }

    function _mintTokenAndApproveContractCall(string memory symbol, uint256 amount, address contractAddress, bytes32 payloadHash) internal {
        _mintToken(symbol, contractAddress, amount);

        address token = tokenAddresses(symbol);
        _setContractCallApprovedWithMint(contractAddress, payloadHash, token, amount);

        emit ContractCallApprovedWithMint(contractAddress, payloadHash, token, amount);
    }

    function _approveContractCall(address contractAddress, bytes32 approvalHash) internal {
        _setContractCallApproved(contractAddress, approvalHash);

        emit ContractCallApproved(contractAddress, approvalHash);
    }

    /********************\
    |* Pure Key Getters *|
    \********************/

    function _getTokenTypeKey(string memory symbol) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(PREFIX_TOKEN_TYPE, symbol));
    }

    function _getFreezeTokenKey(string memory symbol) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(PREFIX_TOKEN_FROZEN, symbol));
    }

    function _getTokenAddressKey(string memory symbol) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(PREFIX_TOKEN_ADDRESS, symbol));
    }

    function _getIsCommandExecutedKey(bytes32 commandId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(PREFIX_COMMAND_EXECUTED, commandId));
    }

    function _getIsContractCallApprovedKey(address contractAddress, bytes32 payloadHash)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(PREFIX_CONTRACT_CALL_APPROVED, contractAddress, payloadHash));
    }

    function _getIsContractCallApprovedWithMintKey(address contractAddress, bytes32 payloadHash, address token, uint256 amount)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(PREFIX_CONTRACT_CALL_APPROVED, contractAddress, payloadHash, token, amount));
    }

    /********************\
    |* Internal Methods *|
    \********************/

    function _callERC20Token(
        address tokenAddress,
        bytes memory callData,
        string memory errorMessage
    ) internal {
        (bool success, bytes memory returnData) = tokenAddress.call(callData);
        require(success && (returnData.length == uint256(0) || abi.decode(returnData, (bool))), errorMessage);
    }

    /********************\
    |* Internal Getters *|
    \********************/

    function _getTokenType(string memory symbol) internal view returns (TokenType) {
        return TokenType(getUint(_getTokenTypeKey(symbol)));
    }

    /********************\
    |* Internal Setters *|
    \********************/

    function _setTokenType(string memory symbol, TokenType tokenType) internal {
        _setUint(_getTokenTypeKey(symbol), uint256(tokenType));
    }

    function _setTokenAddress(string memory symbol, address tokenAddress) internal {
        _setAddress(_getTokenAddressKey(symbol), tokenAddress);
    }

    function _setCommandExecuted(bytes32 commandId, bool executed) internal {
        _setBool(_getIsCommandExecutedKey(commandId), executed);
    }

    function _setContractCallApproved(address contractAddress, bytes32 payloadHash) internal {
        _setBool(_getIsContractCallApprovedKey(contractAddress, payloadHash), true);
    }

    function _setContractCallApprovedWithMint(address contractAddress, bytes32 payloadHash, address token, uint256 amount) internal {
        _setBool(_getIsContractCallApprovedWithMintKey(contractAddress, payloadHash, token, amount), true);
    }

    function _setImplementation(address newImplementation) internal {
        _setAddress(KEY_IMPLEMENTATION, newImplementation);
    }
}
