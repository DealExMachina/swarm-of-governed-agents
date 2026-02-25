# Governance Rego policies

Policies are compiled to WebAssembly for use by the OPA-WASM engine (`src/opaPolicyEngine.ts`).

## Build (optional)

Requires [OPA CLI](https://www.openpolicyagent.org/docs/latest/#running-opa) installed:

```bash
opa build -t wasm -e governance/result -o policies/bundle.tar.gz policies/
cd policies && tar -xzf bundle.tar.gz
```

Or from repo root: `pnpm run build:opa` (if opa is in PATH).

Then set `OPA_WASM_PATH=policies/policy.wasm` (or path to the extracted `policy.wasm` from the bundle) to use the OPA engine instead of YAML. If the WASM file is missing, the app uses the YAML policy engine.

## Entrypoint

The build uses entrypoint `governance/result`, which returns `{ "allow": bool, "reason": string, "suggested_actions": [...] }`. Data (transition_rules and rules) is set at runtime from the loaded governance config.
