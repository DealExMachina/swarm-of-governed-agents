# Governance policy: transition blocking and suggested actions.
# Data: { "transition_rules": [...], "rules": [...] } (from governance YAML).
# Input: { "scope_id", "from_state", "to_state", "drift_level", "drift_types": [] }.

package governance

import future.keywords.if
import future.keywords.in

# Default deny; allow only when no transition rule blocks.
default allow := false

# Allow if no matching block rule.
allow if {
	not block
}

# Block when a transition rule matches: same from/to and drift_level in block_when.
block if {
	rule := data.transition_rules[_]
	rule.from == input.from_state
	rule.to == input.to_state
	input.drift_level in rule.block_when.drift_level
}

# Reason for the decision.
reason := r if {
	block
	rule := data.transition_rules[_]
	rule.from == input.from_state
	rule.to == input.to_state
	input.drift_level in rule.block_when.drift_level
	r := rule.reason
} else := "no blocking rule" if {
	not block
}

# Suggested actions from rules where drift_level and drift_type match.
suggested_actions := actions if {
	actions := [rule.action |
		rule := data.rules[_]
		input.drift_level in rule.when.drift_level
		rule.when.drift_type == input.drift_types[_]
	]
}

# Empty list when no matches.
suggested_actions := [] if {
	not input.drift_types
}
suggested_actions := [] if {
	count([rule |
		rule := data.rules[_]
		input.drift_level in rule.when.drift_level
		rule.when.drift_type == input.drift_types[_]
	]) == 0
}

# Single result object for WASM entrypoint (e.g. -e governance/result).
result := {"allow": allow, "reason": reason, "suggested_actions": suggested_actions}
