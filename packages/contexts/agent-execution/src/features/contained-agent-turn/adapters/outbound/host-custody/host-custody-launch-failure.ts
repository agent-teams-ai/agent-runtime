/** Guarded launch refusal classes, owned by their own module so that the launch
 * and the custody core observe the same identities. The test seam that replaces
 * the guarded launch never replaces this taxonomy.
 *
 * The split is evidence, not diagnostics. Descriptor authority acquisition runs
 * to completion before `StableProcessGroupGuardian` is constructed, and the
 * first statement of that constructor spawns. A refusal raised during
 * acquisition therefore proves that no process was created; a refusal raised by
 * the constructor proves nothing about it.
 */
export class DescriptorAuthorityAcquisitionError extends Error {}

export class GuardianConstructionError extends Error {}
