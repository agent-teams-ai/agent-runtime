// One Agent Execution-owned test implementation, loaded only by development code.
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {findRepoRoot} from "../helpers/repo-root.ts";

const fixture = pathToFileURL(join(findRepoRoot(),
  "packages/contexts/agent-execution/tests/features/contained-agent-turn/support/docker-engine/fake-docker-engine.ts"));
export const {FakeDockerEngine} = await import(fixture.href);
