const { bn, bigExp } = require('../../helpers/lib/numbers')
const { assertBn } = require('../../helpers/asserts/assertBn')
const { buildHelper } = require('../../helpers/wrappers/court')(web3, artifacts)
const { assertRevert } = require('../../helpers/asserts/assertThrow')
const { CLOCK_EVENTS } = require('../../helpers/utils/events')
const { NEXT_WEEK, NOW, ONE_DAY } = require('../../helpers/lib/time')
const { CLOCK_ERRORS, CONTROLLER_ERRORS } = require('../../helpers/utils/errors')
const { assertAmountOfEvents, assertEvent } = require('../../helpers/asserts/assertEvent')

const ERC20 = artifacts.require('ERC20Mock')

contract('Controller', ([_, someone, configGovernor]) => {
  let courtHelper, controller, altController, ANJ

  const EMPTY_RANDOMNESS = '0x0000000000000000000000000000000000000000000000000000000000000000'
  const ANJ_INITIAL_TOTAL_SUPPLY = bn(1000)

  beforeEach('build helper', async () => {
    courtHelper = buildHelper()
    ANJ = await ERC20.new('ANJ Token', 'ANJ', 18)
    await ANJ.generateTokens(someone, ANJ_INITIAL_TOTAL_SUPPLY)
  })

  describe('constructor', () => {
    const termDuration = bn(ONE_DAY)

    context('when setting the first term start time in the past', () => {
      const firstTermStartTime = bn(NOW - 1)

      it('reverts', async () => {
        await assertRevert(courtHelper.deploy({ termDuration, firstTermStartTime }), CLOCK_ERRORS.BAD_FIRST_TERM_START_TIME)
      })
    })

    context('when setting the first term start time previous to one term duration', () => {
      const firstTermStartTime = bn(NOW).add(termDuration.sub(bn(1)))

      it('reverts', async () => {
        await assertRevert(courtHelper.deploy({ termDuration, firstTermStartTime }), CLOCK_ERRORS.BAD_FIRST_TERM_START_TIME)
      })
    })

    context('when setting the first term start time in the future', () => {
      const firstTermStartTime = bn(NEXT_WEEK)

      beforeEach('deploy controller', async () => {
        controller = await courtHelper.deploy({ termDuration, firstTermStartTime, feeToken: ANJ })
      })

      it('it must have already started term #0', async () => {
        const { startTime, randomnessBN, randomness, celesteTokenTotalSupply } = await controller.getTerm(0)

        assertBn(startTime, firstTermStartTime.sub(termDuration), 'term zero start time does not match')
        assertBn(randomnessBN, 0, 'zero term randomness block number should not be computed')
        assert.equal(randomness, EMPTY_RANDOMNESS, 'zero term randomness should not be computed')
        assertBn(celesteTokenTotalSupply, ANJ_INITIAL_TOTAL_SUPPLY, 'zero term total supply should not be computed')
      })

      it('does not require a term transition', async () => {
        assertBn((await controller.getNeededTermTransitions()), 0, 'needed term transitions does not match')
      })
    })
  })

  describe('heartbeat', () => {
    const termDuration = bn(ONE_DAY)
    const firstTermStartTime = bn(NEXT_WEEK)
    const zeroTermStartTime = firstTermStartTime.sub(termDuration)
    const anjNewSupply = bn(1000)
    const feeTokenTotalSupply = bigExp(30000, 18)

    beforeEach('create controller', async () => {
      await ANJ.generateTokens(someone, anjNewSupply)
      controller = await courtHelper.deploy({ termDuration, firstTermStartTime, feeToken: ANJ })
      altController = await courtHelper.deploy({ termDuration, firstTermStartTime, feeToken: ANJ, feeTokenTotalSupply: feeTokenTotalSupply})
    })

    const itRevertsOnHeartbeat = maxTransitionTerms => {
      it('reverts', async () => {
        await assertRevert(controller.heartbeat(maxTransitionTerms), CLOCK_ERRORS.INVALID_TRANSITION_TERMS)
      })
    }

    const itRevertsTryingToTransitionOneTerm = () => {
      context('when the max transition terms given is zero', () => {
        const maxTransitionTerms = 0

        itRevertsOnHeartbeat(maxTransitionTerms)
      })

      context('when the max transition terms given is one', () => {
        const maxTransitionTerms = 1

        itRevertsOnHeartbeat(maxTransitionTerms)
      })
    }

    const itNeedsTermTransitions = neededTransitions => {
      it(`requires ${neededTransitions} term transitions`, async () => {
        assertBn((await controller.getNeededTermTransitions()), neededTransitions, 'needed term transitions does not match')
      })
    }

    const itUpdatesTermsSuccessfully = (maxTransitionTerms, expectedTransitions, remainingTransitions) => {
      it('updates the term id', async () => {
        const previousTermId = await controller.getLastEnsuredTermId()

        const receipt = await controller.heartbeat(maxTransitionTerms)

        assertAmountOfEvents(receipt, CLOCK_EVENTS.HEARTBEAT, 1)
        assertEvent(receipt, CLOCK_EVENTS.HEARTBEAT, { previousTermId, currentTermId: previousTermId.add(bn(expectedTransitions)) })
      })

      it(`initializes ${expectedTransitions} new terms`, async () => {
        const lastEnsuredTermId = await controller.getLastEnsuredTermId()

        await controller.heartbeat(maxTransitionTerms)
        const currentBlockNumber = await controller.getBlockNumberExt()

        for (let transition = 1; transition <= expectedTransitions; transition++) {
          const termId = lastEnsuredTermId.add(bn(transition))
          const { startTime, randomnessBN, randomness, celesteTokenTotalSupply } = await controller.getTerm(termId)

          assertBn(startTime, firstTermStartTime.add(termDuration.mul(bn(transition - 1))), `start time for term ${termId} does not match`)
          assertBn(randomnessBN, currentBlockNumber.add(bn(1)), `randomness block number for term ${termId} should be the next block number`)
          assert.equal(randomness, EMPTY_RANDOMNESS, `randomness for term ${termId} should not be computed`)
          assertBn(celesteTokenTotalSupply, ANJ_INITIAL_TOTAL_SUPPLY.add(anjNewSupply), `total supply for term ${termId} should not be computed`)
        }
      })

      it(`remains ${remainingTransitions} transitions`, async () => {
        await controller.heartbeat(maxTransitionTerms)

        assertBn((await controller.getNeededTermTransitions()), remainingTransitions, 'needed term transitions does not match')
      })

      it(`updates celesteTokenTotalSupply correctly ${expectedTransitions} times`, async () => {
        const lastEnsuredTermId = await controller.getLastEnsuredTermId()

        for (let transition = 1; transition <= expectedTransitions; transition++) {
          await controller.heartbeat(bn(1))
          await ANJ.generateTokens(someone, anjNewSupply)
          const termId = lastEnsuredTermId.add(bn(transition))

          const { celesteTokenTotalSupply } = await controller.getTerm(termId)

          const expectedTotalSupply = ANJ_INITIAL_TOTAL_SUPPLY.add(anjNewSupply.mul(bn(transition)))
          assertBn(celesteTokenTotalSupply, expectedTotalSupply, `total supply for term ${termId} incorrect`)
        }
      })

      it(`updates celesteTokenTotalSupply correctly ${expectedTransitions} times when hardcoded`, async () => {
        const lastEnsuredTermId = await altController.getLastEnsuredTermId()

        for (let transition = 1; transition <= expectedTransitions; transition++) {
          await altController.heartbeat(bn(1))
          await ANJ.generateTokens(someone, anjNewSupply)
          const termId = lastEnsuredTermId.add(bn(transition))

          const { celesteTokenTotalSupply } = await altController.getTerm(termId)

          const expectedTotalSupply = feeTokenTotalSupply
          assertBn(celesteTokenTotalSupply, expectedTotalSupply, `total supply for term ${termId} incorrect`)
        }
      })
    }

    context('when current timestamp is before zero term start time', () => {
      beforeEach('set current timestamp', async () => {
        await controller.mockSetTimestamp(zeroTermStartTime)
      })

      itNeedsTermTransitions(0)
      itRevertsTryingToTransitionOneTerm()
    })

    context('when current timestamp is between zero term and first term ', () => {
      beforeEach('set current timestamp', async () => {
        await controller.mockSetTimestamp(zeroTermStartTime.add(termDuration).div(bn(2)))
      })

      itNeedsTermTransitions(0)
      itRevertsTryingToTransitionOneTerm()
    })

    context('when current timestamp is right at the beginning of the first term', () => {
      beforeEach('set current timestamp', async () => {
        await controller.mockSetTimestamp(firstTermStartTime)
        await altController.mockSetTimestamp(firstTermStartTime)
      })

      itNeedsTermTransitions(1)

      context('when the max transition terms given is zero', () => {
        const maxTransitionTerms = 0

        itRevertsOnHeartbeat(maxTransitionTerms)
      })

      context('when the max transition terms given is one', () => {
        const maxTransitionTerms = 1
        const expectedTransitions = 1
        const remainingTransitions = 0

        itUpdatesTermsSuccessfully(maxTransitionTerms, expectedTransitions, remainingTransitions)
      })
    })

    context('when current timestamp is right at the end of the first term ', () => {
      beforeEach('set current timestamp', async () => {
        await controller.mockSetTimestamp(firstTermStartTime.add(termDuration))
        await altController.mockSetTimestamp(firstTermStartTime.add(termDuration))
      })

      itNeedsTermTransitions(2)

      context('when the max transition terms given is zero', () => {
        const maxTransitionTerms = 0

        itRevertsOnHeartbeat(maxTransitionTerms)
      })

      context('when the max transition terms given is one', () => {
        const maxTransitionTerms = 1
        const expectedTransitions = 1
        const remainingTransitions = 1

        itUpdatesTermsSuccessfully(maxTransitionTerms, expectedTransitions, remainingTransitions)
      })

      context('when the max transition terms given is two', () => {
        const maxTransitionTerms = 2
        const expectedTransitions = 2
        const remainingTransitions = 0

        itUpdatesTermsSuccessfully(maxTransitionTerms, expectedTransitions, remainingTransitions)
      })

      context('when the max transition terms given is three', () => {
        const maxTransitionTerms = 3
        const expectedTransitions = 2
        const remainingTransitions = 0

        itUpdatesTermsSuccessfully(maxTransitionTerms, expectedTransitions, remainingTransitions)
      })
    })

    context('when current timestamp is two terms after the first term', () => {
      beforeEach('set current timestamp', async () => {
        await controller.mockSetTimestamp(firstTermStartTime.add(termDuration.mul(bn(2))))
        await altController.mockSetTimestamp(firstTermStartTime.add(termDuration.mul(bn(2))))
      })

      itNeedsTermTransitions(3)

      context('when the max transition terms given is zero', () => {
        const maxTransitionTerms = 0

        itRevertsOnHeartbeat(maxTransitionTerms)
      })

      context('when the max transition terms given is one', () => {
        const maxTransitionTerms = 1
        const expectedTransitions = 1
        const remainingTransitions = 2

        itUpdatesTermsSuccessfully(maxTransitionTerms, expectedTransitions, remainingTransitions)
      })

      context('when the max transition terms given is two', () => {
        const maxTransitionTerms = 2
        const expectedTransitions = 2
        const remainingTransitions = 1

        itUpdatesTermsSuccessfully(maxTransitionTerms, expectedTransitions, remainingTransitions)
      })

      context('when the max transition terms given is three', () => {
        const maxTransitionTerms = 3
        const expectedTransitions = 3
        const remainingTransitions = 0

        itUpdatesTermsSuccessfully(maxTransitionTerms, expectedTransitions, remainingTransitions)
      })

      context('when the max transition terms given is four', () => {
        const maxTransitionTerms = 4
        const expectedTransitions = 3
        const remainingTransitions = 0

        itUpdatesTermsSuccessfully(maxTransitionTerms, expectedTransitions, remainingTransitions)
      })
    })
  })

  describe('delayStartTime', () => {
    const termDuration = bn(ONE_DAY)
    const firstTermStartTime = bn(NEXT_WEEK)

    beforeEach('create controller', async () => {
      controller = await courtHelper.deploy({ termDuration, firstTermStartTime, configGovernor })
    })

    context('when the sender is the config governor', () => {
      const from = configGovernor

      context('when the court has not started yet', () => {
        beforeEach('assert the court has not started yet', async () => {
          const currentTerm = await controller.getCurrentTermId()
          assertBn(currentTerm, 0, 'court has already started')
        })

        context('when the given timestamp is in the future', () => {
          const newStartTime = firstTermStartTime.add(bn(1))

          it('updates the first term start time', async () => {
            await controller.delayStartTime(newStartTime, { from })

            const { startTime } = await controller.getTerm(0)

            const expectedZeroTermStartTime = newStartTime.sub(termDuration)
            assertBn(startTime, expectedZeroTermStartTime, 'start time does not match')
          })

          it('emits an event', async () => {
            const receipt = await controller.delayStartTime(newStartTime, { from })

            assertAmountOfEvents(receipt, CLOCK_EVENTS.START_TIME_DELAYED)
            assertEvent(receipt, CLOCK_EVENTS.START_TIME_DELAYED, { previousStartTime: firstTermStartTime, currentStartTime: newStartTime })
          })
        })

        context('when the given timestamp is in the past', () => {
          const newStartTime = firstTermStartTime.sub(bn(1))

          it('reverts', async () => {
            await assertRevert(controller.delayStartTime(newStartTime, { from }), CLOCK_ERRORS.CANNOT_DELAY_PAST_START_TIME)
          })
        })
      })

      context('when the court has already started', () => {
        beforeEach('start court', async () => {
          await courtHelper.setTerm(1)

          const currentTerm = await controller.getCurrentTermId()
          assertBn(currentTerm, 1, 'court has not started yet')
        })

        context('when the given timestamp is in the future', () => {
          const newStartTime = firstTermStartTime.add(bn(1))

          it('reverts', async () => {
            await assertRevert(controller.delayStartTime(newStartTime, { from }), CLOCK_ERRORS.CANNOT_DELAY_STARTED_COURT)
          })
        })

        context('when the given timestamp is in the past', () => {
          const newStartTime = firstTermStartTime.sub(bn(1))

          it('reverts', async () => {
            await assertRevert(controller.delayStartTime(newStartTime, { from }), CLOCK_ERRORS.CANNOT_DELAY_STARTED_COURT)
          })
        })
      })
    })

    context('when the sender is not the config governor', () => {
      const from = someone

      it('reverts', async () => {
        await assertRevert(controller.delayStartTime(firstTermStartTime + 1, { from }), CONTROLLER_ERRORS.SENDER_NOT_GOVERNOR)
      })
    })
  })
})
