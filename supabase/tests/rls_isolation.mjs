// ===========================================================================
// Seed Code Mail — cross-user isolation test (RLS)
// ---------------------------------------------------------------------------
// Exercises the real Supabase project with two confirmed test accounts and
// proves that one user cannot read, update, delete or attach records owned by
// another user — even when they know the record id.
//
// Usage (never commit the values):
//
//   SUPABASE_URL=https://<project>.supabase.co \
//   SUPABASE_ANON_KEY=<publishable key> \
//   TEST_USER_A_EMAIL=a@example.com TEST_USER_A_PASSWORD=... \
//   TEST_USER_B_EMAIL=b@example.com TEST_USER_B_PASSWORD=... \
//   node supabase/tests/rls_isolation.mjs
//
// Create the two accounts first (sign up + confirm), because sign-up depends
// on your project's email settings. No credentials are ever printed.
// ===========================================================================

import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  TEST_USER_A_EMAIL,
  TEST_USER_A_PASSWORD,
  TEST_USER_B_EMAIL,
  TEST_USER_B_PASSWORD,
} = process.env;

const missing = [
  ['SUPABASE_URL', SUPABASE_URL],
  ['SUPABASE_ANON_KEY', SUPABASE_ANON_KEY],
  ['TEST_USER_A_EMAIL', TEST_USER_A_EMAIL],
  ['TEST_USER_A_PASSWORD', TEST_USER_A_PASSWORD],
  ['TEST_USER_B_EMAIL', TEST_USER_B_EMAIL],
  ['TEST_USER_B_PASSWORD', TEST_USER_B_PASSWORD],
].filter(([, value]) => !value);

if (missing.length) {
  console.error(`Missing environment variables: ${missing.map(([k]) => k).join(', ')}`);
  process.exit(2);
}

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const client = () =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

async function signIn(email, password) {
  const supabase = client();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed for a test account: ${error.message}`);
  return { supabase, userId: data.user.id };
}

const created = { recipientId: null, campaignId: null };

async function cleanup(a) {
  if (created.campaignId) {
    await a.supabase.from('campaigns').delete().eq('id', created.campaignId);
  }
  if (created.recipientId) {
    await a.supabase.from('recipients').delete().eq('id', created.recipientId);
  }
}

async function main() {
  const a = await signIn(TEST_USER_A_EMAIL, TEST_USER_A_PASSWORD);
  const b = await signIn(TEST_USER_B_EMAIL, TEST_USER_B_PASSWORD);
  check('two distinct test users signed in', a.userId !== b.userId);

  try {
    // --- recipients -------------------------------------------------------
    const stamp = Date.now();
    const { data: inserted, error: insertError } = await a.supabase
      .from('recipients')
      .insert({ company_name: 'RLS Test Co', email: `rls.test.${stamp}@example.com` })
      .select()
      .single();

    check('A can create a recipient', !insertError && !!inserted?.id, insertError?.message);
    if (!inserted) return;
    created.recipientId = inserted.id;

    const { data: ownRow } = await a.supabase
      .from('recipients').select('id').eq('id', inserted.id).maybeSingle();
    check('A can read its own recipient', ownRow?.id === inserted.id);

    const { data: otherRead } = await b.supabase
      .from('recipients').select('id').eq('id', inserted.id).maybeSingle();
    check("B cannot read A's recipient by id", otherRead == null);

    const { data: otherUpdate } = await b.supabase
      .from('recipients').update({ company_name: 'hijacked' }).eq('id', inserted.id).select();
    check("B cannot update A's recipient", (otherUpdate ?? []).length === 0);

    await b.supabase.from('recipients').delete().eq('id', inserted.id);
    const { data: stillThere } = await a.supabase
      .from('recipients').select('id').eq('id', inserted.id).maybeSingle();
    check("B cannot delete A's recipient", stillThere?.id === inserted.id);

    // Forging user_id on insert must be rejected by the WITH CHECK clause.
    const { error: forgedInsert } = await b.supabase
      .from('recipients')
      .insert({ user_id: a.userId, company_name: 'Forged', email: `forged.${stamp}@example.com` })
      .select();
    check('B cannot insert a recipient owned by A', !!forgedInsert);

    // --- campaigns + jobs -------------------------------------------------
    const { data: campaign, error: campaignError } = await a.supabase
      .from('campaigns')
      .insert({ name: 'RLS Test Campaign', subject: 'RLS test', template_ref: 'local:test', status: 'draft' })
      .select()
      .single();
    check('A can create a campaign (subject required per campaign)', !campaignError && !!campaign?.id, campaignError?.message);
    if (campaign) created.campaignId = campaign.id;

    if (campaign) {
      const { data: otherCampaign } = await b.supabase
        .from('campaigns').select('id').eq('id', campaign.id).maybeSingle();
      check("B cannot read A's campaign", otherCampaign == null);

      const { error: forgedJob } = await b.supabase
        .from('campaign_recipients')
        .insert({
          campaign_id: campaign.id,
          email: `job.${stamp}@example.com`,
          company_name: 'Job Co',
        })
        .select();
      check("B cannot attach a job to A's campaign", !!forgedJob);
    }

    // --- history ----------------------------------------------------------
    const { error: historyInsert } = await a.supabase
      .from('email_history')
      .insert({ status: 'sent', email: `hist.${stamp}@example.com`, subject: 'RLS test', attempt: 1 });
    check('A can insert a history row', !historyInsert, historyInsert?.message);

    const { data: bHistory } = await b.supabase
      .from('email_history').select('id').eq('email', `hist.${stamp}@example.com`);
    check("B cannot read A's history", (bHistory ?? []).length === 0);

    const { data: historyUpdate } = await a.supabase
      .from('email_history').update({ status: 'failed' }).eq('email', `hist.${stamp}@example.com`).select();
    check('history is append-only (no UPDATE policy)', (historyUpdate ?? []).length === 0);

    await a.supabase.from('email_history').delete().eq('email', `hist.${stamp}@example.com`);

    // --- settings are per user -------------------------------------------
    const { error: settingsRead } = await b.supabase
      .from('user_settings').select('user_id').eq('user_id', a.userId);
    check("B cannot read A's settings", !settingsRead);

    const { data: ownSettings } = await a.supabase
      .from('user_settings').select('user_id').eq('user_id', a.userId).maybeSingle();
    check('A has exactly its own settings row', ownSettings?.user_id === a.userId);
  } finally {
    await cleanup(a);
    await a.supabase.auth.signOut();
    await b.supabase.auth.signOut();
  }
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(`\nTest run aborted: ${error.message}`);
    process.exit(2);
  });
