const chai = require('chai');
const { ethers } = require('hardhat');
const {
    utils: { keccak256, Interface },
    constants: { AddressZero },
} = ethers;
const { expect } = chai;

describe('AxelarAuthWeighted', () => {
    let signer1, signer2, signer3, signer4, signer5, signer6, nonSigner;
    let initAccounts;
    let rotatedAccounts;

    let multiSigFactory;
    let multiSig;

    before(async () => {
        [signer1, signer2, signer3, signer4, signer5, signer6, nonSigner] = await ethers.getSigners();
        initAccounts = [signer1, signer2, signer3].map((signer) => signer.address);
        rotatedAccounts = [signer4, signer5, signer6].map((signer) => signer.address);

        multiSigFactory = await ethers.getContractFactory('TestMultiSigBase', signer1);
    });

    beforeEach(async () => {
        multiSig = await multiSigFactory.deploy(initAccounts, 2).then((d) => d.deployed());
    });

    it('should return the signer threshold for a given epoch', async () => {
        const currentEpoch = 1;
        const currentThreshold = 2;

        expect(await multiSig.signerThreshold(currentEpoch)).to.equal(currentThreshold);
    });

    it('should return the array of signers for a given epoch', async () => {
        const currentEpoch = 1;

        expect(await multiSig.signerAccounts(currentEpoch)).to.deep.equal(initAccounts);
    });

    it('should revert if non-signer calls only signers function', async () => {
        const newThreshold = 2;

        await expect(multiSig.connect(nonSigner).rotateSigners(rotatedAccounts, newThreshold)).to.be.revertedWithCustomError(
            multiSig,
            'NotSigner',
        );
    });

    it('should not proceed with operation execution with insufficient votes', async () => {
        const newThreshold = 2;

        const tx = await multiSig.connect(signer1).rotateSigners(rotatedAccounts, newThreshold);

        await expect(tx).to.not.emit(multiSig, 'MultisigOperationExecuted');
    });

    it('should revert if signer tries to vote twice', async () => {
        const newThreshold = 2;

        await multiSig
            .connect(signer1)
            .rotateSigners(rotatedAccounts, newThreshold)
            .then((tx) => tx.wait());

        await expect(multiSig.connect(signer1).rotateSigners(rotatedAccounts, newThreshold)).to.be.revertedWithCustomError(
            multiSig,
            'AlreadyVoted',
        );
    });

    it('should refund the sender if value is sent for execution with insufficient votes', async () => {
        const newThreshold = 2;
        const initialBalance = await ethers.provider.getBalance(signer1.address);

        const tx = await multiSig.connect(signer1).rotateSigners(rotatedAccounts, newThreshold, { value: 10000 });

        const receipt = await tx.wait();
        const gasCost = receipt.effectiveGasPrice.mul(receipt.gasUsed);

        const finalBalance = await ethers.provider.getBalance(signer1.address);

        expect(finalBalance).to.equal(initialBalance.sub(gasCost));
    });

    it('should proceed with operation execution with sufficient votes', async () => {
        const newThreshold = 2;

        const rotateInterface = new Interface([
            'function rotateSigners(address[] memory newAccounts, uint256 newThreshold) external payable',
        ]);
        const msgData = rotateInterface.encodeFunctionData('rotateSigners', [rotatedAccounts, newThreshold]);
        const msgDataHash = keccak256(msgData);

        await multiSig
            .connect(signer1)
            .rotateSigners(rotatedAccounts, newThreshold)
            .then((tx) => tx.wait());

        await expect(multiSig.connect(signer2).rotateSigners(rotatedAccounts, newThreshold))
            .to.emit(multiSig, 'MultisigOperationExecuted')
            .withArgs(msgDataHash);
    });

    it('should revert on rotate signers if new threshold is too large', async () => {
        const newThreshold = 4;

        await multiSig
            .connect(signer1)
            .rotateSigners(rotatedAccounts, newThreshold)
            .then((tx) => tx.wait());

        await expect(multiSig.connect(signer2).rotateSigners(rotatedAccounts, newThreshold)).to.be.revertedWithCustomError(
            multiSig,
            'InvalidSigners',
        );
    });

    it('should revert on rotate signers if new threshold is zero', async () => {
        const newThreshold = 0;

        await multiSig
            .connect(signer1)
            .rotateSigners(rotatedAccounts, newThreshold)
            .then((tx) => tx.wait());

        await expect(multiSig.connect(signer2).rotateSigners(rotatedAccounts, newThreshold)).to.be.revertedWithCustomError(
            multiSig,
            'InvalidSignerThreshold',
        );
    });

    it('should revert on rotate signers with any duplicate signers', async () => {
        const newThreshold = 2;

        const rotatedAccountsWithDuplicate = rotatedAccounts.concat(signer4.address);

        await multiSig
            .connect(signer1)
            .rotateSigners(rotatedAccountsWithDuplicate, newThreshold)
            .then((tx) => tx.wait());

        await expect(multiSig.connect(signer2).rotateSigners(rotatedAccountsWithDuplicate, newThreshold)).to.be.revertedWithCustomError(
            multiSig,
            'DuplicateSigner',
        );
    });

    it('should revert on rotate signers with any invalid signer addresses', async () => {
        const newThreshold = 2;

        const rotatedAccountsInvalid = rotatedAccounts.concat(AddressZero);

        await multiSig
            .connect(signer1)
            .rotateSigners(rotatedAccountsInvalid, newThreshold)
            .then((tx) => tx.wait());

        await expect(multiSig.connect(signer2).rotateSigners(rotatedAccountsInvalid, newThreshold)).to.be.revertedWithCustomError(
            multiSig,
            'InvalidSigners',
        );
    });

    it('should proceed with signer rotation with sufficient votes and valid arguments', async () => {
        const newThreshold = 2;

        const rotateInterface = new Interface([
            'function rotateSigners(address[] memory newAccounts, uint256 newThreshold) external payable',
        ]);
        const msgData = rotateInterface.encodeFunctionData('rotateSigners', [rotatedAccounts, newThreshold]);
        const msgDataHash = keccak256(msgData);

        await multiSig
            .connect(signer1)
            .rotateSigners(rotatedAccounts, newThreshold)
            .then((tx) => tx.wait());

        await expect(multiSig.connect(signer2).rotateSigners(rotatedAccounts, newThreshold))
            .to.emit(multiSig, 'MultisigOperationExecuted')
            .withArgs(msgDataHash)
            .and.to.emit(multiSig, 'SignersRotated')
            .withArgs(rotatedAccounts, newThreshold);
    });
});
