# Third-party software

The MIT license in this repository covers Roster's original source. It does not
relicense dependencies, external agent CLIs, models, or independently installed
services. The existing “Receipt contributors” copyright line is retained as
historical attribution; the project's current name is Roster.

Exact JavaScript dependency versions are recorded in each `package-lock.json`;
the desktop native dependencies are recorded in `apps/desktop/src-tauri/Cargo.lock`.
Preserve the licenses and notices shipped with those packages when distributing
bundled software. The Node.js executable packaged by desktop has its own notices.

## SpacetimeDB

Roster's module and TypeScript clients use SpacetimeDB 2.6.1. The installed npm
SDK declares the ISC license. The independently installed server uses the
[SpacetimeDB 2.6.1 Business Source License](https://github.com/clockworklabs/SpacetimeDB/blob/v2.6.1/LICENSE.txt).
That server license is not an open-source license at this version. Its additional
use grant limits production use to one instance and excludes a defined database
service. Consult the pinned upstream terms for deployment and redistribution;
Roster's MIT license does not expand those rights.

The source repository does not bundle a SpacetimeDB server binary. Local setup
and verification use the operator's installed CLI. A hosted distribution needs
its own deployment and licensing assessment.

## Runtime integrations and releases

Codex, Claude, Pi, Hermes, and other runtimes retain their own licenses and
provider/account terms. Installing an integration does not grant rights to
redistribute an external CLI or resell access to its service.

Before shipping a desktop installer, generate a dependency inventory from the
locked production install, include required license texts, and review the actual
bundled artifacts. A useful JavaScript inventory command is:

```bash
npm sbom --omit=dev --sbom-format=cyclonedx > roster-sbom.json
```

Release archives and study outputs are generated separately and do not belong
in the source tree.
