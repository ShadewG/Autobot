#!/usr/bin/env node
/**
 * Debug script: fetch workspace API response for case 25161 and find all object fields
 */

async function main() {
  const r = await fetch('https://sincere-strength-production.up.railway.app/api/requests/25161/workspace');
  const data = await r.json();

  // Check request fields
  const req = data.request;
  console.log('=== request field types ===');
  for (const [k, v] of Object.entries(req)) {
    if (typeof v === 'object' && v !== null) {
      console.log(k, ':', Array.isArray(v) ? `Array[${v.length}]` : 'Object', JSON.stringify(v).substring(0, 200));
    }
  }

  console.log('\n=== agency_summary field types ===');
  for (const [k, v] of Object.entries(data.agency_summary)) {
    if (typeof v === 'object' && v !== null) {
      console.log(k, ':', Array.isArray(v) ? `Array[${v.length}]` : 'Object', JSON.stringify(v).substring(0, 200));
    }
  }

  // Check next_action_proposal
  console.log('\nnext_action_proposal:', data.next_action_proposal);
  console.log('pending_proposal:', data.pending_proposal);
  console.log('review_state:', data.review_state);
  console.log('active_run:', data.active_run);

  // Check agent_decisions - look for any object fields
  console.log('\n=== agent_decisions ===');
  if (data.agent_decisions && data.agent_decisions.length > 0) {
    data.agent_decisions.forEach((d, i) => {
      for (const [k, v] of Object.entries(d)) {
        console.log(`decision[${i}].${k} type=${typeof v} value=${JSON.stringify(v).substring(0, 150)}`);
      }
    });
  } else {
    console.log('No agent decisions');
  }

  // Check deadline_milestones
  console.log('\n=== deadline_milestones ===');
  console.log(JSON.stringify(data.deadline_milestones, null, 2));

  // Check constraints
  console.log('\n=== constraints (first 3) ===');
  if (req.constraints) {
    req.constraints.slice(0, 3).forEach((c, i) => {
      console.log(`constraint[${i}]:`, JSON.stringify(c));
    });
    console.log('Total:', req.constraints.length);
  }

  // Check scope_items (first 3)
  console.log('\n=== scope_items (first 3) ===');
  if (req.scope_items) {
    req.scope_items.slice(0, 3).forEach((s, i) => {
      console.log(`scope_item[${i}]:`, JSON.stringify(s));
    });
    console.log('Total:', req.scope_items.length);
  }

  // Check fee_quote
  console.log('\n=== fee_quote ===');
  console.log(JSON.stringify(req.fee_quote, null, 2));

  // Check due_info
  console.log('\n=== due_info ===');
  console.log(JSON.stringify(req.due_info, null, 2));

  // Check timeline events (first 3) for any unusual fields
  console.log('\n=== timeline_events (first 3) ===');
  if (data.timeline_events) {
    data.timeline_events.slice(0, 3).forEach((e, i) => {
      const fields = {};
      for (const [k, v] of Object.entries(e)) {
        if (typeof v === 'object' && v !== null) {
          fields[k] = Array.isArray(v) ? `Array[${v.length}]` : JSON.stringify(v).substring(0, 100);
        }
      }
      console.log(`event[${i}] type=${e.type} summary="${e.summary}" objectFields=`, fields);
    });
    console.log('Total events:', data.timeline_events.length);
  }

  // Check thread_messages (look for any object summaries)
  console.log('\n=== thread_messages with object fields ===');
  if (data.thread_messages) {
    data.thread_messages.forEach((m, i) => {
      for (const [k, v] of Object.entries(m)) {
        if (typeof v === 'object' && v !== null && k !== 'attachments') {
          console.log(`message[${i}].${k} type=${typeof v} value=${JSON.stringify(v).substring(0, 100)}`);
        }
      }
    });
    console.log('Total messages:', data.thread_messages.length);
  }
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
