#ifndef AE_DARWIN_ATTEMPT_OWNER_MATERIAL_H
#define AE_DARWIN_ATTEMPT_OWNER_MATERIAL_H
#include "darwin-attempt-owner-custody.h"
/* Fixed installation data validation is portable; no authority is issued. */
int ae_material_uuid_valid(const uint8_t *,size_t);
#ifdef __APPLE__
int ae_native_observe_launch(ae_custody *,uint8_t [AE_OBSERVATION_BYTES],uint32_t);
int ae_native_material_begin(ae_custody *,const uint8_t *,size_t);
int ae_native_material_chunk(ae_custody *,const uint8_t *,size_t);
int ae_native_material_finish(ae_custody *,uint8_t [AE_MATERIAL_RESULT_BYTES],uint32_t);
int ae_native_validate_launch(ae_custody *);
#endif
#endif
