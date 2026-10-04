---
inclusion: auto
---

# Testing Rules

Applies to all tests under `test/unit/`, `test/property/`, and `test/integration/`.

Reference: Req 16.3

---

## Rule 1 — PRF_Output Arbitraries Must Be 32-Byte `Uint8Array`

Property-based tests that exercise the key-derivation path accept `PRF_Output` values. These values are 32-byte byte strings by definition, so the fast-check arbitrary **must** reflect that constraint exactly.

**Correct:**
```ts
const prfOutputArb = fc.uint8Array({ minLength: 32, maxLength: 32 });
```

**Incorrect:**
```ts
fc.string()           // strings are not Uint8Arrays
fc.hexaString()       // hex strings are not Uint8Arrays
fc.uint8Array()       // unconstrained length breaks the derivation contract
```

Live example from `test/property/derivation.property.test.ts`:
```ts
/** Arbitrary for a fixed 32-byte Uint8Array (PRF_Output). */
const prfOutputArb = fc.uint8Array({ minLength: 32, maxLength: 32 });
```

Do not widen or relax this constraint. If a property needs a different shape, introduce a separate named arbitrary and document why.

---

## Rule 2 — No Property-Based Test May Connect to Real Hardware

All tests — unit, property, and integration — must use `MockHardwareIdentityProvider`. Tests must be executable in CI environments that have no FIDO2 devices attached.

**Correct:**
```ts
import { MockHardwareIdentityProvider } from "../mocks/MockHardwareIdentityProvider";

const provider = new MockHardwareIdentityProvider();
```

**Incorrect:**
```ts
// Never import or instantiate the real hardware provider in tests
import { Libfido2HardwareIdentityProvider } from "../../src/main/hardware/...";
import { libfido2 } from "...";

const provider = new Libfido2HardwareIdentityProvider();
```

Canonical mock: `test/mocks/MockHardwareIdentityProvider.ts`

This rule ensures:
- Tests run reliably in CI without hardware.
- Tests are deterministic (see Rule 3).
- fast-check can shrink failing examples — shrinking requires reproducible output, which real hardware cannot guarantee.

---

## Rule 3 — `MockHardwareIdentityProvider` Must Be Deterministic Within a Test Run

For the same `credentialId`, `getAssertion()` must return the same `hmacOutput` every time within a single test run. This is essential for fast-check's shrinking phase to work correctly.

**How the mock achieves determinism:**

`getAssertion()` computes `HMAC-SHA256(key="mock-secret", data=credentialId)` on first call and caches the result in an internal `Map`. Subsequent calls for the same `credentialId` return the cached value.

```ts
// From test/mocks/MockHardwareIdentityProvider.ts
let hmacOutput = this._hmacCache.get(hexKey);

if (hmacOutput === undefined) {
  const digest = createHmac("sha256", "mock-secret")
    .update(Buffer.from(credentialId))
    .digest();
  hmacOutput = new Uint8Array(digest);
  this._hmacCache.set(hexKey, hmacOutput);
}
```

You can also pin a specific output for a `credentialId` using `setHmacOutput()`:

```ts
mock.setHmacOutput(credentialId, new Uint8Array(prfOutput));
```

**Incorrect — never use random bytes for `hmacOutput` in a mock:**
```ts
// BAD — breaks fast-check shrinking
return { hmacOutput: new Uint8Array(crypto.randomBytes(32)), credentialId };
return { hmacOutput: new Uint8Array(Array.from({ length: 32 }, () => Math.random() * 256)), credentialId };
```

Each `MockHardwareIdentityProvider` instance has its own independent cache, so instantiating a fresh mock per property-test run is fine — as long as the same instance returns consistent output during that run.

---

## Test Organisation

| Directory | Contents |
|---|---|
| `test/unit/` | Unit tests — one file per service (e.g., `DerivationService.test.ts`) |
| `test/property/` | fast-check property tests with `numRuns: 100` minimum |
| `test/integration/` | Integration tests using `MockHardwareIdentityProvider` |
| `test/mocks/` | Shared mock implementations |

---

## Annotation Convention for Property Tests

Every property test must carry a comment header that identifies the feature and property number:

```ts
// Feature: key-wallet, Property N: <name>
```

Example from `test/property/derivation.property.test.ts`:
```ts
// Feature: key-wallet, Property 1: Derivation Determinism
// Validates: Requirements 18.1
describe("Property 1: Derivation Determinism", () => { ... });
```

Include a `// Validates: Requirements X.Y` line when there is a direct requirements reference.
