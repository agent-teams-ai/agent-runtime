# Runtime profile experiments

Status: evidence and falsifiable candidate models only.

Nothing under this directory is production architecture or reusable runtime
core. The canonical decision is:

`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

The tests intentionally preserve some historical hypotheses so their evidence
remains reproducible. A green experiment suite does not approve those
hypotheses for production.

Known superseded or falsified candidate behavior:

- `authority-binding` may directly request
  `retire-generation-and-restart`; ADR-0001 instead requires Security to record
  revocation and Agent Execution to fence, stop, and reconcile without an
  automatic successor;
- the profile-composition candidate mixes grants and security revisions into
  one manifest identity; ADR-0001 separates `CompiledProfilePlan`,
  `ResourceAuthorization`, review, and live activation;
- the capture candidate rejects direct symlinks and source replacement but is
  not a production security boundary because later bind-mount and ancestor
  race probes escaped the intended root;
- team launch planning belongs to the orchestrator and must not move into AR.

New implementation may adapt provider observations, fixtures, and conformance
cases. It must not copy candidate domain models or helpers into production
packages.
