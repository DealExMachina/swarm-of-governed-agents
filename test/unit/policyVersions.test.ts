import { describe, it, expect } from "vitest";
import { getGovernancePolicyVersion, getFinalityPolicyVersion } from "../../src/policyVersions";
import { join } from "path";

describe("policyVersions", () => {
  it("getGovernancePolicyVersion returns 64-char hex when file exists", () => {
    const path = join(__dirname, "../../governance.yaml");
    const v = getGovernancePolicyVersion(path);
    expect(v).toMatch(/^[a-f0-9]{64}$/);
  });

  it("getGovernancePolicyVersion returns no-file when path missing", () => {
    const v = getGovernancePolicyVersion("/nonexistent/governance.yaml");
    expect(v).toBe("no-file");
  });

  it("getFinalityPolicyVersion returns 64-char hex when file exists", () => {
    const path = join(__dirname, "../../finality.yaml");
    const v = getFinalityPolicyVersion(path);
    expect(v).toMatch(/^[a-f0-9]{64}$/);
  });
});
