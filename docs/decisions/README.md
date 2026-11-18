# Owner decisions

Use `needs-owner-ruling` when an issue needs a product, policy, or scope decision. The owner states the ruling on the issue; a contributor then records it here as `YYYY-MM-DD-issue-N-slug.md`, links the record from the issue, and replaces the label with `owner-ruled`.

Record the issue link, decision, reason, scope, and any earlier decision it replaces. A label is a status indicator, not merge or release permission. Existing rulings remain applicable within their stated scope. Ask the owner explicitly before replacing one; preserve the old record and link both records.

```markdown
# Decision title

Date: YYYY-MM-DD
Issue: https://github.com/pugport/pugport/issues/N
Owner ruling: <link to the owner's comment>
Decision: <what was decided>
Reason: <why>
Scope: <where this applies and any limits>
Replaces: <prior record and reason, or none>
```
