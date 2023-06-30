// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { IAxelarServiceGovernance } from '../interfaces/IAxelarServiceGovernance.sol';
import { InterchainGovernance } from './InterchainGovernance.sol';
import { MultisigBase } from '../auth/MultisigBase.sol';

/**
 * @title AxelarServiceGovernance Contract
 * @dev This contract is part of the Axelar Governance system, it inherits the Interchain Governance contract
 * with added functionality to approve and execute multisig proposals.
 */
contract AxelarServiceGovernance is InterchainGovernance, MultisigBase, IAxelarServiceGovernance {
    enum ServiceGovernanceCommand {
        ScheduleTimeLockProposal,
        CancelTimeLockProposal,
        ApproveMultisigProposal,
        CancelMultisigApproval
    }

    mapping(bytes32 => bool) public multisigApprovals;

    /**
     * @notice Initializes the contract.
     * @param gatewayAddress The address of the Axelar gateway contract
     * @param governanceChain The name of the governance chain
     * @param governanceAddress The address of the governance contract
     * @param minimumTimeDelay The minimum time delay for timelock operations
     * @param signers The list of initial signers
     * @param threshold The number of required signers to validate a transaction
     */
    constructor(
        address gatewayAddress,
        string memory governanceChain,
        string memory governanceAddress,
        uint256 minimumTimeDelay,
        address[] memory signers,
        uint256 threshold
    ) InterchainGovernance(gatewayAddress, governanceChain, governanceAddress, minimumTimeDelay) {
        _rotateSigners(signers, threshold);
    }

    /**
     * @notice Executes a multisig proposal.
     * @param target The target address the proposal will call
     * @param callData The data that encodes the function and arguments to call on the target contract
     */
    function executeMultisigProposal(address target, bytes calldata callData) external payable onlySigners {
        bytes32 proposalHash = keccak256(abi.encodePacked(target, callData, msg.value));

        if (!multisigApprovals[proposalHash]) revert NotApproved();

        multisigApprovals[proposalHash] = false;

        (bool success, ) = target.call{ value: msg.value }(callData);

        if (!success) {
            revert ExecutionFailed();
        }

        emit MultisigExecuted(proposalHash);
    }

    /**
     * @notice Internal function to process a governance command
     * @param commandId The id of the command
     * @param target The target address the proposal will call
     * @param callData The data the encodes the function and arguments to call on the target contract
     * @param nativeValue The value of native token to be sent to the target contract
     * @param eta The time after which the proposal can be executed
     */
    function _processCommand(
        uint256 commandId,
        address target,
        bytes memory callData,
        uint256 nativeValue,
        uint256 eta
    ) internal override {
        ServiceGovernanceCommand command = ServiceGovernanceCommand(commandId);
        bytes32 proposalHash = keccak256(abi.encodePacked(target, callData, nativeValue));

        if (command == ServiceGovernanceCommand.ScheduleTimeLockProposal) {
            eta = _scheduleTimeLock(proposalHash, eta);

            emit ProposalScheduled(proposalHash, target, callData, nativeValue, eta);
        } else if (command == ServiceGovernanceCommand.CancelTimeLockProposal) {
            _cancelTimeLock(proposalHash);

            emit ProposalCancelled(proposalHash, target, callData, nativeValue, eta);
        } else if (command == ServiceGovernanceCommand.ApproveMultisigProposal) {
            multisigApprovals[proposalHash] = true;

            emit MultisigApproved(proposalHash, target, callData);
        } else if (command == ServiceGovernanceCommand.CancelMultisigApproval) {
            multisigApprovals[proposalHash] = false;

            emit MultisigCancelled(proposalHash);
        } else {
            revert InvalidCommand();
        }
    }
}
