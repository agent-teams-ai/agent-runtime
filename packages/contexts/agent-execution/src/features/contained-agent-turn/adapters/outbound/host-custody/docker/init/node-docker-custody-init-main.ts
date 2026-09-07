import { writeSync } from "node:fs";

import {
  DOCKER_CUSTODY_INIT_CONFIGURATION_ENVIRONMENT,
  parseDockerCustodyInitConfiguration,
} from "./docker-custody-init-configuration.js";
import { NodeDockerCustodyInitDriver } from "./node-docker-custody-init-driver.js";

// Side-effectful build entry. The independently reviewed image must bundle this entry
// and its complete JS closure into /ar-custody-init.mjs; this source is not that artifact.
try {
  const options = parseDockerCustodyInitConfiguration(process.env[DOCKER_CUSTODY_INIT_CONFIGURATION_ENVIRONMENT]);
  process.exitCode = await new NodeDockerCustodyInitDriver(options).run();
} catch {
  process.exitCode = 1;
  try {writeSync(2, "custody init startup failed\n");} catch { /* Closed stderr cannot turn failure into success. */ }
}
