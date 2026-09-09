#include <stdio.h>
/* No CLI flag, manifest FD, peer UID, digest or environment variable can mint
 * root admission. Root's exact launcher, immutable loader/ancestor capture,
 * reserved UID+GID authority and isolated Host channel do not exist in this
 * ownership slice. Even uid 0 refuses BEFORE creating namespace or child.
 * Replacing this gate requires reviewed root integration and qualification;
 * it must not become a structural registerEvidence({trusted:true}) switch. */
int main(void) {
  fputs("darwin-attempt-owner: admission unavailable: exact root launcher, "
        "exclusive UID/GID authority, immutable inputs, isolated Host bridge "
        "and qualified native preexec policy are not supplied\n",stderr);
  return 78;
}
