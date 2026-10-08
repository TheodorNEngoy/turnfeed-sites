// Authorization and preview validation belong to the caller. This shared helper
// prepares one complete state change; callers commit it once against its revision.
export function controlsAfterErasure(controls, userId) {
  const owns = key => {
    const text = String(key);
    if (text.startsWith('[')) {
      try { const values = JSON.parse(text); return Array.isArray(values) && values[0] === userId; } catch { return false; }
    }
    return text.split(':').includes(userId);
  };
  return { ...controls,
    recentRequests: controls.recentRequests.filter(([k]) => !owns(k)),
    recentSocialSignalSuccesses: controls.recentSocialSignalSuccesses.filter(([k]) => !owns(k)),
    pendingProfileUpdates: controls.pendingProfileUpdates.filter(([k]) => !owns(k)),
    publicWriteConfirmationClaims: controls.publicWriteConfirmationClaims.filter(([, v]) => !owns(v.ownerKey)),
    rateState: controls.rateState.map(([k, values]) => [k, values.filter(([caller]) => !owns(caller))]),
  };
}

export async function prepareErasedState({ loaded, core, actor, userId, requestId, caseId, scope, retainedRecordsReason }) {
  const operator = structuredClone(loaded.value?.operator || { revoked: {}, erasures: [] });
  if (operator.erasures.length >= 500 || Object.keys(operator.revoked).length >= 500) {
    return { ok: false, status: 503, code: 'erasure_journal_capacity' };
  }
  const result = await core.operator.eraseAccount(userId);
  if (!result?.ok) return result;
  const at = new Date().toISOString();
  operator.revoked[userId] = { at, caseId };
  operator.erasures.push({ id: requestId, actor, target: userId, at, caseId, scope,
    retainedRecordsReason, accessEffect: 'Turnfeed app admission revoked; ChatGPT account and provider tokens unchanged' });
  const profileNameChoices = { ...loaded.value?.profileNameChoices };
  delete profileNameChoices[userId];
  return { ok: true, value: { ...loaded.value, format: 1, snapshot: core.snapshot(),
    controls: controlsAfterErasure(core.controls(), userId), profileNameChoices, operator } };
}
