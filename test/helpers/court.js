const { decodeEventsOfType } = require('./decodeEvent')
const { NEXT_WEEK, ONE_DAY } = require('./time')
const { getEvents, getEventArgument } = require('@aragon/os/test/helpers/events')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const APPEAL_COLLATERAL_FACTOR = 3
const APPEAL_CONFIRMATION_COLLATERAL_FACTOR = 2

const DISPUTE_STATES = {
  PRE_DRAFT: 0,
  ADJUDICATING: 1,
  EXECUTED: 2
}

const ROUND_STATES = {
  INVALID: 0,
  COMMITTING: 1,
  REVEALING: 2,
  APPEALING: 3,
  CONFIRMING_APPEAL: 4,
  ENDED: 5
}

module.exports = (web3, artifacts) => {
  const { bn, bigExp } = require('./numbers')(web3)
  const { SALT, getVoteId, encryptVote, oppositeOutcome, outcomeFor } = require('../helpers/crvoting')(web3)

  // TODO: update default to make sure we test using real values
  const DEFAULTS = {
    termDuration:                       bn(ONE_DAY),     //  terms lasts one week
    firstTermStartTime:                 bn(NEXT_WEEK),   //  first term starts one week after mocked timestamp
    commitTerms:                        bn(1),           //  vote commits last 1 term
    revealTerms:                        bn(1),           //  vote reveals last 1 term
    appealTerms:                        bn(1),           //  appeals last 1 term
    appealConfirmTerms:                 bn(1),           //  appeal confirmations last 1 term
    jurorFee:                           bigExp(10, 18),  //  10 fee tokens for juror fees
    heartbeatFee:                       bigExp(20, 18),  //  20 fee tokens for heartbeat fees
    draftFee:                           bigExp(30, 18),  //  30 fee tokens for draft fees
    settleFee:                          bigExp(40, 18),  //  40 fee tokens for settle fees
    penaltyPct:                         bn(100),         //  1% (1/10,000)
    finalRoundReduction:                bn(3300),        //  33% (1/10,000)
    appealStepFactor:                   bn(3),           //  each time a new appeal occurs, the amount of jurors to be drafted will be incremented 3 times
    maxRegularAppealRounds:             bn(3),           //  there can be up to 3 appeals in total per dispute
    jurorsMinActiveBalance:             bigExp(100, 18), //  100 ANJ is the minimum balance jurors must activate to participate in the Court
    subscriptionPeriodDuration:         bn(0),           //  none subscription period
    subscriptionFeeAmount:              bn(0),           //  none subscription fee
    subscriptionPrePaymentPeriods:      bn(0),           //  none subscription pre payment period
    subscriptionLatePaymentPenaltyPct:  bn(0),           //  none subscription late payment penalties
    subscriptionGovernorSharePct:       bn(0),           //  none subscription governor shares
  }

  class CourtHelper {
    constructor(web3, artifacts) {
      this.web3 = web3
      this.artifacts = artifacts
    }

    async getDispute(disputeId) {
      const [subject, possibleRulings, state, finalRuling, lastRoundId] = await this.court.getDispute(disputeId)
      return { subject, possibleRulings, state, finalRuling, lastRoundId }
    }

    async getRound(disputeId, roundId) {
      const [draftTerm, delayedTerms, roundJurorsNumber, selectedJurors, triggeredBy, settledPenalties, collectedTokens, coherentJurors, roundState] = await this.court.getRound(disputeId, roundId)
      return { draftTerm, delayedTerms, roundJurorsNumber, selectedJurors, triggeredBy, settledPenalties, collectedTokens, coherentJurors, roundState }
    }

    async getAppeal(disputeId, roundId) {
      const [appealer, appealedRuling, taker, opposedRuling] = await this.court.getAppeal(disputeId, roundId)
      return { appealer, appealedRuling, taker, opposedRuling }
    }

    async getRoundJuror(disputeId, roundId, juror) {
      const [weight, rewarded] = await this.court.getJuror(disputeId, roundId, juror)
      return { weight, rewarded }
    }

    async getRoundLockBalance(disputeId, roundId, juror) {
      if (roundId < this.maxRegularAppealRounds) {
        const lockPerDraft = this.jurorsMinActiveBalance.mul(this.penaltyPct).div(10000)
        const { weight } = await this.getRoundJuror(disputeId, roundId, juror)
        return lockPerDraft.mul(weight)
      } else {
        const { draftTerm } = await this.getRound(disputeId, roundId)
        const draftActiveBalance = await this.jurorsRegistry.activeBalanceOfAt(juror, draftTerm)
        if (draftActiveBalance.lt(this.jurorsMinActiveBalance)) return bn(0)
        return draftActiveBalance.mul(this.penaltyPct).div(10000)
      }
    }

    async getFinalRoundWeight(disputeId, roundId, juror) {
      const { draftTerm } = await this.getRound(disputeId, roundId)
      const draftActiveBalance = await this.jurorsRegistry.activeBalanceOfAt(juror, draftTerm)
      if (draftActiveBalance.lt(this.jurorsMinActiveBalance)) return bn(0)
      return draftActiveBalance.mul(1000).divToInt(this.jurorsMinActiveBalance)
    }

    async getAppealFees(disputeId, roundId) {
      const nextRoundJurorsNumber = await this.getNextRoundJurorsNumber(disputeId, roundId)
      return this.getDraftDepositFor(nextRoundJurorsNumber)
    }

    async getAppealDeposit(disputeId, roundId) {
      const totalFees = await this.getAppealFees(disputeId, roundId)
      return totalFees.mul(APPEAL_COLLATERAL_FACTOR)
    }

    async getConfirmAppealDeposit(disputeId, roundId) {
      const totalFees = await this.getAppealFees(disputeId, roundId)
      return totalFees.mul(APPEAL_CONFIRMATION_COLLATERAL_FACTOR)
    }

    async getNextRoundJurorsNumber(disputeId, roundId) {
      const { roundJurorsNumber } = await this.getRound(disputeId, roundId)
      return this.getNextRoundJurorsNumberFor(roundJurorsNumber)
    }

    getNextRoundJurorsNumberFor(jurorsNumber) {
      let nextRoundJurorsNumber = this.appealStepFactor.mul(jurorsNumber).toNumber()
      if (nextRoundJurorsNumber % 2 === 0) nextRoundJurorsNumber++
      return nextRoundJurorsNumber
    }

    getDraftDepositFor(jurorsNumber) {
      const jurorFees = this.jurorFee.mul(jurorsNumber)
      const draftFees = this.draftFee.mul(jurorsNumber)
      const settleFees = this.settleFee.mul(jurorsNumber)
      return this.heartbeatFee.plus(jurorFees).plus(draftFees).plus(settleFees)
    }

    async setTimestamp(timestamp) {
      await this.jurorsRegistry.mockSetTimestamp(timestamp)
      await this.court.mockSetTimestamp(timestamp)
    }

    async increaseTime(seconds) {
      await this.jurorsRegistry.mockIncreaseTime(seconds)
      await this.court.mockIncreaseTime(seconds)
    }

    async advanceBlocks(blocks) {
      await this.jurorsRegistry.mockAdvanceBlocks(blocks)
      await this.court.mockAdvanceBlocks(blocks)
    }

    async setTerm(termId) {
      // set timestamp corresponding to given term ID
      await this.setTimestamp(this.firstTermStartTime.plus(this.termDuration.mul(termId - 1)))
      // call heartbeat function for X needed terms
      const neededTransitions = await this.court.neededTermTransitions()
      if (neededTransitions.gt(0)) await this.court.heartbeat(neededTransitions)
    }

    async passTerms(terms) {
      // increase X terms based on term duration
      await this.increaseTime(this.termDuration.mul(terms))
      // call heartbeat function for X terms
      await this.court.heartbeat(terms)
      // advance 2 blocks to ensure we can compute term randomness
      await this.advanceBlocks(2)
    }

    async passRealTerms(terms) {
      // increase X terms based on term duration
      await this.increaseTime(this.termDuration.mul(terms))
      // call heartbeat function for X terms
      await this.court.heartbeat(terms)
      // advance 2 blocks to ensure we can compute term randomness
      const { advanceBlocks } = require('../helpers/blocks')(web3)
      await advanceBlocks(2)
    }

    async mintFeeTokens(address, amount = bigExp(1e6, 18)) {
      const allowance = await this.feeToken.allowance(address, this.court.address)
      if (allowance.gt(0)) await this.feeToken.approve(this.court.address, 0, { from: address })

      await this.feeToken.generateTokens(address, amount)
      await this.feeToken.approve(this.court.address, amount, { from: address })
    }

    async activate(jurors) {
      const ACTIVATE_DATA = web3.sha3('activate(uint256)').slice(0, 10)

      for (const { address, initialActiveBalance } of jurors) {
        await this.jurorToken.generateTokens(address, initialActiveBalance)
        await this.jurorToken.approveAndCall(this.jurorsRegistry.address, initialActiveBalance, ACTIVATE_DATA, { from: address })
      }
    }

    async dispute({ jurorsNumber, draftTermId, possibleRulings = 2, arbitrable = undefined, disputer = undefined }) {
      // mint enough fee tokens for the disputer, if no disputer was given pick the second account
      if (!disputer) disputer = web3.eth.accounts[1]
      await this.mintFeeTokens(disputer)

      // create an arbitrable if no one was given, and mock subscriptions
      if (!arbitrable) arbitrable = await this.artifacts.require('ArbitrableMock').new()
      await this.subscriptions.setUpToDate(true)

      // create dispute and return id
      const receipt = await this.court.createDispute(arbitrable.address, possibleRulings, jurorsNumber, draftTermId, { from: disputer })
      return getEventArgument(receipt, 'NewDispute', 'disputeId')
    }

    async draft({ disputeId, maxJurorsToBeDrafted = undefined, draftedJurors = undefined, drafter = undefined }) {
      // if no drafter was given pick the third account
      if (!drafter) drafter = web3.eth.accounts[2]

      // draft all jurors if there was no max given
      if (!maxJurorsToBeDrafted) {
        const { lastRoundId } = await this.getDispute(disputeId)
        const { roundJurorsNumber } = await this.getRound(disputeId, lastRoundId)
        maxJurorsToBeDrafted = roundJurorsNumber.toNumber()
      }

      // mock draft if there was a jurors set to be drafted
      if (draftedJurors) {
        const totalWeight = draftedJurors.reduce((total, { weight }) => total + weight, 0)
        if (totalWeight !== maxJurorsToBeDrafted) throw Error('Given jurors to be drafted do not fit the round jurors number')
        const jurors = draftedJurors.map(j => j.address)
        const weights = draftedJurors.map(j => j.weight)
        await this.jurorsRegistry.mockNextDraft(jurors, weights)
      }

      // draft and flat jurors with their weights
      const receipt = await this.court.draft(disputeId, maxJurorsToBeDrafted, { from: drafter })
      const logs = decodeEventsOfType(receipt, this.artifacts.require('JurorsRegistry').abi, 'JurorDrafted')
      const weights = getEvents({ logs }, 'JurorDrafted').reduce((jurors, event) => {
        const { juror } = event.args
        jurors[juror] = (jurors[juror] || 0) + 1
        return jurors
      }, {})
      return Object.keys(weights).map(address => ({ address, weight: weights[address] }))
    }

    async commit({ disputeId, roundId, voters }) {
      // commit votes of each given voter
      const voteId = getVoteId(disputeId, roundId)
      for (let i = 0; i < voters.length; i++) {
        let { address, outcome } = voters[i]
        // if no outcome was set for the given outcome, pick one based on its index
        if (!outcome) outcome = outcomeFor(i)
        await this.voting.commit(voteId, encryptVote(outcome), { from: address })
      }

      // move to reveal period
      await this.passTerms(this.commitTerms)
    }

    async reveal({ disputeId, roundId, voters }) {
      // reveal votes of each given voter
      const voteId = getVoteId(disputeId, roundId)
      for (let i = 0; i < voters.length; i++) {
        let { address, outcome } = voters[i]
        // if no outcome was set for the given outcome, pick one based on its index
        if (!outcome) outcome = outcomeFor(i)
        await this.voting.reveal(voteId, outcome, SALT, { from: address })
      }

      // move to appeal period
      await this.passTerms(this.revealTerms)
    }

    async appeal({ disputeId, roundId, appealMaker = undefined, ruling = undefined }) {
      // mint fee tokens for the appealer, if no appealer was given pick the fourth account
      if (!appealMaker) appealMaker = web3.eth.accounts[3]
      await this.mintFeeTokens(appealMaker)

      // use the opposite to the round winning ruling for the appeal if no one was given
      if (!ruling) {
        const voteId = getVoteId(disputeId, roundId)
        const winningRuling = await this.voting.getWinningOutcome(voteId)
        ruling = oppositeOutcome(winningRuling)
      }

      // appeal and move to confirm appeal period
      await this.court.appeal(disputeId, roundId, ruling, { from: appealMaker })
      await this.passTerms(this.appealTerms)
    }

    async confirmAppeal({ disputeId, roundId, appealTaker = undefined, ruling = undefined }) {
      // mint fee tokens for the appeal taker, if no taker was given pick the fifth account
      if (!appealTaker) appealTaker = web3.eth.accounts[4 + roundId * 2]
      await this.mintFeeTokens(appealTaker)

      // use the opposite ruling the one appealed if no one was given
      if (!ruling) {
        const { appealedRuling } = await this.getAppeal(disputeId, roundId)
        ruling = oppositeOutcome(appealedRuling)
      }

      // confirm appeal and move to end of confirm appeal period
      await this.court.confirmAppeal(disputeId, roundId, ruling, { from: appealTaker })
      await this.passTerms(this.appealConfirmTerms)
    }

    async settle({ disputeId, jurors }) {
      // execute ruling
      const { finalRuling, lastRoundId } = (await this.getDispute(disputeId)).toNumber()
      await this.court.executeRuling(disputeId)

      // settle penalties for each round
      for (let roundId = 0; roundId <= lastRoundId; roundId++) {
        const { roundJurorsNumber } = await this.getRound(disputeId, roundId)
        await this.court.settlePenalties(disputeId, roundId, roundJurorsNumber)
      }

      // settle juror rewards for each round
      const coherentJurors = []
      for (let roundId = 0; roundId <= lastRoundId; roundId++) {
        const voteId = getVoteId(disputeId, roundId)

        for (const juror of jurors) {
          const votedOutcome = await this.voting.getVoterOutcome(voteId, juror)
          if (votedOutcome.eq(finalRuling)) {
            coherentJurors.push(juror)
            await this.court.settleReward(disputeId, roundId, juror.address)
          }
        }
      }

      return coherentJurors
    }

    async moveToFinalRound({ disputeId, fromRoundId = 0 }) {
      for (let roundId = fromRoundId; roundId < this.maxRegularAppealRounds; roundId++) {
        const draftedJurors = await this.draft({ disputeId })
        await this.commit({ disputeId, roundId, voters: draftedJurors })
        await this.reveal({ disputeId, roundId, voters: draftedJurors })
        await this.appeal({ disputeId, roundId })
        await this.confirmAppeal({ disputeId, roundId })
      }
    }

    async deploy(params) {
      Object.assign(this, { ...DEFAULTS, ...params })
      if (!this.governor) this.governor = this.web3.eth.accounts[0]
      if (!this.voting) this.voting = await this.artifacts.require('CRVoting').new()
      if (!this.accounting) this.accounting = await this.artifacts.require('CourtAccounting').new()
      if (!this.feeToken) this.feeToken = await this.artifacts.require('MiniMeToken').new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'Court Fee Token', 18, 'CFT', true)
      if (!this.jurorToken) this.jurorToken = await this.artifacts.require('MiniMeToken').new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'Aragon Network Juror Token', 18, 'ANJ', true)
      if (!this.jurorsRegistry) this.jurorsRegistry =  await this.artifacts.require('JurorsRegistryMock').new()
      if (!this.subscriptions) this.subscriptions = await this.artifacts.require('SubscriptionsMock').new()

      this.court = await artifacts.require('CourtMock').new(
        this.termDuration,
        [ this.jurorToken.address, this.feeToken.address ],
        this.jurorsRegistry.address,
        this.accounting.address,
        this.voting.address,
        this.subscriptions.address,
        [ this.jurorFee, this.heartbeatFee, this.draftFee, this.settleFee ],
        this.governor,
        this.firstTermStartTime,
        this.jurorsMinActiveBalance,
        [ this.commitTerms, this.revealTerms, this.appealTerms, this.appealConfirmTerms ],
        [ this.penaltyPct, this.finalRoundReduction ],
        this.appealStepFactor,
        this.maxRegularAppealRounds,
        [ this.subscriptionPeriodDuration, this.subscriptionFeeAmount, this.subscriptionPrePaymentPeriods, this.subscriptionLatePaymentPenaltyPct, this.subscriptionGovernorSharePct ]
      )

      const zeroTermStartTime = this.firstTermStartTime - this.termDuration
      await this.setTimestamp(zeroTermStartTime)

      return this.court
    }
  }

  return {
    DEFAULTS,
    DISPUTE_STATES,
    ROUND_STATES,
    buildHelper: () => new CourtHelper(web3, artifacts),
  }
}
