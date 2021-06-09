const { buildHelper } = require('../helpers/wrappers/court')(web3, artifacts)
const { assertRevert } = require('../helpers/asserts/assertThrow')
const { assertBn } = require('../helpers/asserts/assertBn')
const { bn, bigExp } = require('../helpers/lib/numbers')

const DonatedFeesDrip = artifacts.require('DonatedFeesDrip')

const DEFAULT_PERCENT_YIELD = bigExp(2084, 13) // 2.084% (~25% apy)
const ONE_HUNDRED_PERCENT = bigExp(1, 18)

contract('DonatedFeesDrip', ([_, juror, owner, notOwner]) => {
  let courtDeployment, controller, donatedFeesDrip

  beforeEach(async () => {
    courtDeployment = buildHelper()
    controller = await courtDeployment.deploy()
    donatedFeesDrip = await DonatedFeesDrip.new(controller.address, DEFAULT_PERCENT_YIELD)
  })

  describe('dripFees()', () => {
    it('deposits correct amount for first period', async () => {
      const totalStaked = bigExp(100, 18)
      await courtDeployment.activate([{ address: juror, initialActiveBalance: totalStaked }])
      await courtDeployment.passTerms(11)
      await courtDeployment.mintFeeTokens(donatedFeesDrip.address, bigExp(50, 18))

      await donatedFeesDrip.dripFees()

      const expectedBalance = totalStaked.mul(DEFAULT_PERCENT_YIELD).div(ONE_HUNDRED_PERCENT)
      const actualBalance = await courtDeployment.feeToken.balanceOf(courtDeployment.subscriptions.address)
      assertBn(actualBalance, expectedBalance, 'Incorrect balance')
    })

    it('deposits correct amount for second period and reverts before', async () => {
      const totalStaked = bigExp(100, 18)
      await courtDeployment.activate([{ address: juror, initialActiveBalance: totalStaked }])
      await courtDeployment.passTerms(11)
      await courtDeployment.mintFeeTokens(donatedFeesDrip.address, bigExp(50, 18))

      await donatedFeesDrip.dripFees()
      await courtDeployment.passTerms(10)
      await donatedFeesDrip.dripFees()

      const expectedBalance = totalStaked.mul(DEFAULT_PERCENT_YIELD).div(ONE_HUNDRED_PERCENT).mul(bn(2))
      const actualBalance = await courtDeployment.feeToken.balanceOf(courtDeployment.subscriptions.address)
      assertBn(actualBalance, expectedBalance, 'Incorrect balance')
    })

    it('reverts after first period but second has not started', async () => {
      const totalStaked = bigExp(100, 18)
      await courtDeployment.activate([{ address: juror, initialActiveBalance: totalStaked }])
      await courtDeployment.passTerms(11)
      await courtDeployment.mintFeeTokens(donatedFeesDrip.address, bigExp(50, 18))

      await donatedFeesDrip.dripFees()
      await courtDeployment.passTerms(5)
      await assertRevert(donatedFeesDrip.dripFees(), 'ERROR: Not new period')
    })

    it('reverts when not new period', async () => {
      await courtDeployment.activate([{ address: juror, initialActiveBalance: bigExp(100, 18) }])
      await courtDeployment.passTerms(9)

      await assertRevert(donatedFeesDrip.dripFees(), 'ERROR: Not new period')
    })

    it('reverts when not enough funds', async () => {
      await courtDeployment.activate([{ address: juror, initialActiveBalance: bigExp(100, 18) }])
      await courtDeployment.passTerms(11)

      await assertRevert(donatedFeesDrip.dripFees(), 'ERROR: Not enough funds')
    })
  })

  describe('reclaimFunds()', () => {
    it('returns funds to specified address', async () => {
      const tokenBalance = bigExp(50, 18)
      await courtDeployment.mintFeeTokens(donatedFeesDrip.address, tokenBalance)
      await donatedFeesDrip.reclaimFunds(courtDeployment.feeToken.address, owner)
      await assertBn(await courtDeployment.feeToken.balanceOf(owner), tokenBalance, 'Incorrect token balance')
    })

    it('reverts when not owner', async () => {
      await assertRevert(donatedFeesDrip.reclaimFunds(courtDeployment.feeToken.address, owner, { from: notOwner }), 'Ownable: caller is not the owner')
    })

    it('returns funds after transferring ownership', async () => {
      const tokenBalance = bigExp(50, 18)
      await courtDeployment.mintFeeTokens(donatedFeesDrip.address, tokenBalance)

      await donatedFeesDrip.transferOwnership(owner)
      await donatedFeesDrip.reclaimFunds(courtDeployment.feeToken.address, owner, { from: owner })

      await assertBn(await courtDeployment.feeToken.balanceOf(owner), tokenBalance, 'Incorrect token balance')
    })
  })

  describe('updatePeriodPercentageYield()', () => {
    it('updates period percentage yield', async () => {
      const totalStaked = bigExp(100, 18)
      await courtDeployment.activate([{ address: juror, initialActiveBalance: totalStaked }])
      await courtDeployment.passTerms(11)
      await courtDeployment.mintFeeTokens(donatedFeesDrip.address, bigExp(50, 18))
      const periodYield = bigExp(5, 17) // 50% of total staked

      await donatedFeesDrip.updatePeriodPercentageYield(periodYield)

      await donatedFeesDrip.dripFees()
      const expectedBalance = totalStaked.mul(periodYield).div(ONE_HUNDRED_PERCENT)
      const actualBalance = await courtDeployment.feeToken.balanceOf(courtDeployment.subscriptions.address)
      assertBn(actualBalance, expectedBalance, 'Incorrect balance')
    })

    it('reverts when not owner', async () => {
      const periodYield = bigExp(5, 17) // 50% of total staked
      await assertRevert(donatedFeesDrip.updatePeriodPercentageYield(periodYield, { from: notOwner }), "Ownable: caller is not the owner")
    })
  })
})
