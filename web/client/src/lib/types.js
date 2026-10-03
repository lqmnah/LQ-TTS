// JSDoc shapes of contract C2 (LQ-TTS browser API). Imported only for editor type checking.

/** @typedef {'id'|'en'} Lang */
/** @typedef {{id:string, name:string, email:string, plan:string, paid:boolean, lang:Lang, balance:number|null, voiceLimit:number, voiceCount:number|null, topupUrl:string}} Me */
/** Answer of `/auth/login`; `/auth/2fa` gives the same minus `need_2fa`. @typedef {{status:'ok', user:Me} | {status:'need_2fa', challenge:string} | {status:'needs_verification', verifyUrl:string}} LoginResult */
/** @typedef {{engine:'ok'|'restarting', lqstudio:'ok'|'down', signupUrl:string}} Health */
/** `previewUrl` is null until the voice is ready. @typedef {{id:string, name:string, language:string|null, status:'processing'|'ready'|'failed', errorCode:string|null, refSeconds:number|null, createdAt:string, previewUrl:string|null}} Voice */
/** @typedef {{chars:number, credits:number, rupiah:number, balance:number|null, sentences:number}} Estimate */
/** @typedef {{speed:number, pause_sentence_s:number, pause_paragraph_s:number, formats:Array<'mp3'|'wav'|'srt'|'vtt'>}} JobSettings */
/** @typedef {{id:string, title:string, voiceId:string, voiceName:string, status:'queued'|'running'|'done'|'failed'|'canceled', chars:number, credits:number, audioSeconds:number|null, revision:number, createdAt:string, finishedAt:string|null}} JobSummary */
/** `errorCode` is the engine reason of a failed job, null otherwise. @typedef {JobSummary & {progress:{done:number,total:number}, needsReview:number, settings:JobSettings, files:Record<string,string>, revisions:number[], errorCode:string|null}} JobDetail */
/** @typedef {{idx:number, paragraphIdx:number, text:string, style:string|null, status:'pending'|'running'|'done'|'needs_review', score:number|null, durationS:number|null, startS:number|null, endS:number|null, audioUrl:string|null}} Sentence */
/** `title` is null for holds not linked to a job. @typedef {{id:string, jobId:string|null, title:string|null, kind:'job'|'regenerate', chars:number, credits:number, state:'held'|'settled'|'refunded', createdAt:string}} UsageRow */
/** @typedef {{balance:number|null, topupUrl:string, usage:UsageRow[]}} Credits */

export {};
