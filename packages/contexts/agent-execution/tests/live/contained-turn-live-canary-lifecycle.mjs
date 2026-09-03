/**
 * Runs the live-canary body around an exact kernel custody reservation.
 * A rejected open has no kernel reservation that this layer is authorized to
 * contain. Partial Host allocation must be represented by an explicit typed
 * cleanup/rollback result; this layer never infers that result.
 */
export const runContainedTurnLiveCanaryLifecycle = async input => {
  let failure;
  let failed = false;
  let opened = false;
  let physicalContainment;
  let value;
  const preserveFirstFailure = error => {
    if (!failed) {
      failed = true;
      failure = error;
    }
  };

  try {
    const reservation = await input.open();
    opened = true;
    value = await input.execute(reservation);
  } catch (error) {
    preserveFirstFailure(error);
  }

  if (opened) {
    try {
      physicalContainment = await input.requestPhysicalContainment();
    } catch (error) {
      preserveFirstFailure(error);
    }
  }

  try {
    await input.dispose();
  } catch (error) {
    preserveFirstFailure(error);
  }

  if (failed) { throw failure; }
  return Object.freeze({ physicalContainment, value });
};
