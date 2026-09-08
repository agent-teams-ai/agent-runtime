import { StableProcessGroupGuardian as NativeGuardian } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-stable-guardian.js";

export const observation: {guardian?: StableProcessGroupGuardian} = {};
export class StableProcessGroupGuardian extends NativeGuardian {
  readonly descriptors: ConstructorParameters<typeof NativeGuardian>[0]["descriptors"];
  constructor(input: ConstructorParameters<typeof NativeGuardian>[0], timeout: number) {
    super(input, timeout);
    this.descriptors = input.descriptors;
    Object.assign(observation, {guardian: this});
  }
}
export const reset = () => {delete observation.guardian;};
