# Social posts (tag @WeMakeDevs @truefoundry)

## Post 1 (build clip)
An AI agent once deleted a production DB and said the data was unrecoverable.

So for the #AgentHarnessHackathon I built SafeRun on @truefoundry's TrueForge:
it executes your destructive SQL in a CLONE of production first, proves the
rollback restores every row, and only touches prod after a human clicks Allow.

Not "are you sure?" but "I already tested your undo. Here's the proof."

@WeMakeDevs

## Post 2 (surprise finding)
Demo moment I didn't script: asked my agent to delete 90 rental rows.

It refused. It had mapped the foreign keys and found every payment partition
references rentals: the "90 row" delete was secretly a 180-row delete.

It surfaced the hidden blast radius, asked me which scope I meant, simulated
both, and verified the rollback before touching anything.

That's what an agent harness is for. TrueForge's approval gate + MCP tools +
skills did the heavy lifting. @WeMakeDevs @truefoundry

## Post 3 (technical)
The safety boundary in SafeRun is not the prompt.

execute_approved_operation refuses at code level unless:
- the simulation exists
- the operation succeeded in the clone
- the rollback VERIFIED (every table checksum restored)

A jailbroken model literally cannot skip the protocol. Plus TrueForge's
native human approval gate on top. Defense in depth for agents that touch
production. @WeMakeDevs @truefoundry #AgentHarnessHackathon
