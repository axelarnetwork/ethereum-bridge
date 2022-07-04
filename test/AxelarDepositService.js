'use strict';

const chai = require('chai');
const {
    Contract,
    utils: { defaultAbiCoder, arrayify, solidityPack, formatBytes32String, keccak256, getCreate2Address },
} = require('ethers');
const { deployContract, MockProvider, solidity } = require('ethereum-waffle');
chai.use(solidity);
const { expect } = chai;
const { get } = require('lodash/fp');

const CHAIN_ID = 1;
const ROLE_OWNER = 1;

const Auth = require('../artifacts/contracts/AxelarAuthMultisig.sol/AxelarAuthMultisig.json');
const TokenDeployer = require('../artifacts/contracts/TokenDeployer.sol/TokenDeployer.json');
const AxelarGatewayProxy = require('../artifacts/contracts/AxelarGatewayProxy.sol/AxelarGatewayProxy.json');
const AxelarGateway = require('../artifacts/contracts/AxelarGateway.sol/AxelarGateway.json');
const TestWeth = require('../artifacts/contracts/test/TestWeth.sol/TestWeth.json');
const DepositService = require('../artifacts/contracts/deposit-service/AxelarDepositService.sol/AxelarDepositService.json');
const DepositServiceProxy = require('../artifacts/contracts/deposit-service/AxelarDepositServiceProxy.sol/AxelarDepositServiceProxy.json');
const DepositReceiver = require('../artifacts/contracts/deposit-service/DepositReceiver.sol/DepositReceiver.json');

const { getAuthDeployParam, getSignedMultisigExecuteInput, getRandomID } = require('./utils');

describe('AxelarDepositService', () => {
    const [ownerWallet, operatorWallet, userWallet, adminWallet1, adminWallet2, adminWallet3, adminWallet4, adminWallet5, adminWallet6] =
        new MockProvider().getWallets();
    const adminWallets = [adminWallet1, adminWallet2, adminWallet3, adminWallet4, adminWallet5, adminWallet6];
    const threshold = 3;

    let gateway;
    let token;
    let wrongToken;
    let depositService;

    const destinationChain = 'chain A';
    const tokenName = 'Wrapped Eth';
    const tokenSymbol = 'WETH';
    const wrongTokenName = 'Wrapped Eth';
    const wrongTokenSymbol = 'WETH';
    const decimals = 16;
    const capacity = 0;

    beforeEach(async () => {
        const params = arrayify(
            defaultAbiCoder.encode(['address[]', 'uint8', 'bytes'], [adminWallets.map(get('address')), threshold, '0x']),
        );
        const auth = await deployContract(ownerWallet, Auth, [getAuthDeployParam([[operatorWallet.address]], [1])]);
        const tokenDeployer = await deployContract(ownerWallet, TokenDeployer);
        const gatewayImplementation = await deployContract(ownerWallet, AxelarGateway, [auth.address, tokenDeployer.address]);
        const gatewayProxy = await deployContract(ownerWallet, AxelarGatewayProxy, [gatewayImplementation.address, params]);
        await auth.transferOwnership(gatewayProxy.address);
        gateway = new Contract(gatewayProxy.address, AxelarGateway.abi, ownerWallet);

        token = await deployContract(ownerWallet, TestWeth, [tokenName, tokenSymbol, decimals, capacity]);
        wrongToken = await deployContract(ownerWallet, TestWeth, [wrongTokenName, wrongTokenSymbol, decimals, capacity]);

        await token.deposit({ value: 1e9 });
        await wrongToken.deposit({ value: 1e9 });

        await gateway.execute(
            await getSignedMultisigExecuteInput(
                arrayify(
                    defaultAbiCoder.encode(
                        ['uint256', 'uint256', 'bytes32[]', 'string[]', 'bytes[]'],
                        [
                            CHAIN_ID,
                            ROLE_OWNER,
                            [getRandomID()],
                            ['deployToken'],
                            [
                                defaultAbiCoder.encode(
                                    ['string', 'string', 'uint8', 'uint256', 'address', 'uint256'],
                                    [tokenName, tokenSymbol, decimals, capacity, token.address, 0],
                                ),
                            ],
                        ],
                    ),
                ),
                [operatorWallet],
                [operatorWallet],
            ),
        );

        const depositImplementation = await deployContract(ownerWallet, DepositService, [gateway.address, tokenSymbol]);
        const depositProxy = await deployContract(ownerWallet, DepositServiceProxy, [depositImplementation.address, '0x']);
        depositService = new Contract(depositProxy.address, DepositService.abi, ownerWallet);
    });

    describe('deposit service', () => {
        it('should send native token', async () => {
            const destinationAddress = userWallet.address.toString();
            const amount = 1e6;

            await expect(depositService.sendNative(destinationChain, destinationAddress, { value: amount }))
                .to.emit(gateway, 'TokenSent')
                .withArgs(depositService.address, destinationChain, destinationAddress, tokenSymbol, amount);
        });

        it('should handle and transfer ERC20 token', async () => {
            const refundAddress = ownerWallet.address;
            const destinationAddress = userWallet.address.toString();
            const salt = formatBytes32String(1);
            const amount = 1e6;

            const expectedDepositAddress = getCreate2Address(
                depositService.address,
                salt,
                keccak256(
                    solidityPack(
                        ['bytes', 'bytes'],
                        [
                            DepositReceiver.bytecode,
                            defaultAbiCoder.encode(
                                ['bytes'],
                                [
                                    depositService.interface.encodeFunctionData('receiveAndTransferToken', [
                                        refundAddress,
                                        destinationChain,
                                        destinationAddress,
                                        tokenSymbol,
                                    ]),
                                ],
                            ),
                        ],
                    ),
                ),
            );

            const depositAddress = await depositService.depositAddressForTransferToken(
                salt,
                refundAddress,
                destinationChain,
                destinationAddress,
                tokenSymbol,
            );

            expect(depositAddress).to.be.equal(expectedDepositAddress);

            await token.transfer(depositAddress, amount);
            await expect(depositService.transferToken(salt, refundAddress, destinationChain, destinationAddress, tokenSymbol))
                .to.emit(gateway, 'TokenSent')
                .withArgs(depositAddress, destinationChain, destinationAddress, tokenSymbol, amount);
        });

        it('should refund from transfer token address', async () => {
            const refundAddress = ownerWallet.address;
            const destinationAddress = userWallet.address.toString();
            const salt = formatBytes32String(1);
            const amount = 1e6;

            const depositAddress = await depositService.depositAddressForTransferToken(
                salt,
                refundAddress,
                destinationChain,
                destinationAddress,
                tokenSymbol,
            );

            await token.transfer(depositAddress, amount);
            await wrongToken.transfer(depositAddress, amount * 2);

            await expect(
                depositService.refundFromTransferToken(salt, refundAddress, destinationChain, destinationAddress, tokenSymbol, [
                    token.address,
                ]),
            ).not.to.emit(token, 'Transfer');

            await ownerWallet.sendTransaction({
                to: depositAddress,
                value: amount,
            });

            await expect(
                await depositService.refundFromTransferToken(salt, refundAddress, destinationChain, destinationAddress, tokenSymbol, [
                    wrongToken.address,
                ]),
            )
                .to.emit(wrongToken, 'Transfer')
                .withArgs(depositAddress, refundAddress, amount * 2)
                .to.changeEtherBalance(ownerWallet, amount);
        });

        it('should wrap and transfer native currency', async () => {
            const refundAddress = ownerWallet.address;
            const destinationAddress = userWallet.address.toString();
            const salt = formatBytes32String(1);
            const amount = 1e6;

            const expectedDepositAddress = getCreate2Address(
                depositService.address,
                salt,
                keccak256(
                    solidityPack(
                        ['bytes', 'bytes'],
                        [
                            DepositReceiver.bytecode,
                            defaultAbiCoder.encode(
                                ['bytes'],
                                [
                                    depositService.interface.encodeFunctionData('receiveAndTransferNative', [
                                        refundAddress,
                                        destinationChain,
                                        destinationAddress,
                                    ]),
                                ],
                            ),
                        ],
                    ),
                ),
            );

            const depositAddress = await depositService.depositAddressForTransferNative(
                salt,
                refundAddress,
                destinationChain,
                destinationAddress,
            );

            expect(depositAddress).to.be.equal(expectedDepositAddress);

            await ownerWallet.sendTransaction({
                to: depositAddress,
                value: amount,
            });

            await expect(await depositService.transferNative(salt, refundAddress, destinationChain, destinationAddress))
                .to.emit(gateway, 'TokenSent')
                .withArgs(depositAddress, destinationChain, destinationAddress, tokenSymbol, amount);
        });

        it('should refund from transfer native address', async () => {
            const refundAddress = ownerWallet.address;
            const destinationAddress = userWallet.address.toString();
            const salt = formatBytes32String(1);
            const amount = 1e6;

            const depositAddress = await depositService.depositAddressForTransferNative(
                salt,
                refundAddress,
                destinationChain,
                destinationAddress,
            );

            await ownerWallet.sendTransaction({
                to: depositAddress,
                value: amount,
            });
            await wrongToken.transfer(depositAddress, amount * 2);

            await expect(
                depositService.refundFromTransferNative(salt, refundAddress, destinationChain, destinationAddress, [wrongToken.address]),
            )
                .to.emit(wrongToken, 'Transfer')
                .withArgs(depositAddress, refundAddress, amount * 2);
        });

        it('should unwrap native currency', async () => {
            const refundAddress = ownerWallet.address;
            const recipient = userWallet.address;
            const salt = formatBytes32String(1);
            const amount = 1e6;

            const expectedDepositAddress = getCreate2Address(
                depositService.address,
                salt,
                keccak256(
                    solidityPack(
                        ['bytes', 'bytes'],
                        [
                            DepositReceiver.bytecode,
                            defaultAbiCoder.encode(
                                ['bytes'],
                                [depositService.interface.encodeFunctionData('receiveAndWithdrawNative', [refundAddress, recipient])],
                            ),
                        ],
                    ),
                ),
            );

            const depositAddress = await depositService.depositAddressForWithdrawNative(salt, refundAddress, recipient);

            expect(depositAddress).to.be.equal(expectedDepositAddress);

            await token.transfer(depositAddress, amount);

            await expect(await depositService.withdrawNative(salt, refundAddress, recipient)).to.changeEtherBalance(userWallet, amount);
        });

        it('should refund from unwrap native address', async () => {
            const refundAddress = ownerWallet.address;
            const recipient = userWallet.address;
            const salt = formatBytes32String(1);
            const amount = 1e6;

            const depositAddress = await depositService.depositAddressForWithdrawNative(salt, refundAddress, recipient);

            await token.transfer(depositAddress, amount);
            await wrongToken.transfer(depositAddress, amount * 2);

            await expect(depositService.refundFromWithdrawNative(salt, refundAddress, recipient, [token.address])).not.to.emit(
                token,
                'Transfer',
            );

            await ownerWallet.sendTransaction({
                to: depositAddress,
                value: amount,
            });

            await expect(await depositService.refundFromWithdrawNative(salt, refundAddress, recipient, [wrongToken.address]))
                .to.emit(wrongToken, 'Transfer')
                .withArgs(depositAddress, refundAddress, amount * 2)
                .to.changeEtherBalance(ownerWallet, amount);
        });
    });
});
