import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalRoot, inspectRepositoryPath, portableRepositoryPath} from './feature-module-paths.mjs';
import {parseDeterministicJson} from './feature-module-config.mjs';
import {CANDIDATE_MIGRATION_CODES} from './feature-module-profile.mjs';
import {checkFeatureModules, formatIssues} from './feature-module-analysis.mjs';
import {checkOrdinaryFeatureScope} from './check-ordinary-feature-scope.mjs';
export {checkFeatureModules, formatIssues, scopedFeaturePrimitives} from './feature-module-analysis.mjs';
const DEFAULT_PROFILE = 'architecture/feature-module-standard/candidate-profile.json';
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profileIndex = process.argv.indexOf("--profile"), rootIndex = process.argv.indexOf("--root");
  const profilePath = profileIndex >= 0 ? process.argv[profileIndex + 1] : DEFAULT_PROFILE, root = rootIndex >= 0 ? process.argv[rootIndex + 1] : REPOSITORY_ROOT;
  const requiredStatus = process.argv.includes("--require-active") ? "active" : undefined;
  const issues = await checkFeatureModules({ profilePath, requiredStatus, root });
  if (profilePath === DEFAULT_PROFILE) {
    issues.push(...await checkOrdinaryFeatureScope({root}));
  }
  if (issues.length) {
    process.stdout.write(`${formatIssues(issues)}\n\nFeature Module Standard ${requiredStatus ?? "candidate"}: ${issues.length} diagnostic(s). No conformance claim.\n`);
    let profileStatus;
    try {
      const rootIdentity = await canonicalRoot(root), portableProfile = portableRepositoryPath(profilePath);
      const inspected = portableProfile && await inspectRepositoryPath(rootIdentity, portableProfile);
      profileStatus = inspected?.ok ? parseDeterministicJson(await readFile(inspected.absolutePath, "utf8")).status : undefined;
    } catch { profileStatus = undefined; }
    const candidateOnlyAllowance = process.argv.includes("--allow-diagnostics")
      && !requiredStatus
      && profileStatus === "candidate"
      && issues.every(({ code }) => CANDIDATE_MIGRATION_CODES.has(code));
    process.exitCode = candidateOnlyAllowance ? 0 : 1;
  } else if (requiredStatus) {process.stdout.write("Feature Module Standard active: 0 diagnostics.\n");}
  else {process.stdout.write("Feature Module Standard candidate: 0 diagnostics. Activation remains a separate reviewed change.\n");}
}
