export const TERMINAL = new Set(['done', 'failed', 'canceled']);

const FINISHED = new Set(['done', 'needs_review']);

function fromSnapshot(job, sentences) {
  return {
    status: job.status,
    revision: job.revision,
    errorCode: job.errorCode ?? null,
    total: sentences.length || job.progress?.total || 0,
    sentences: Object.fromEntries(sentences.map((s) => [s.idx, { status: s.status, score: s.score ?? null }])),
    lastArrived: null,
  };
}

export function doneCount(state) {
  return Object.values(state.sentences).filter((s) => FINISHED.has(s.status)).length;
}

export function progressReducer(state, action) {
  switch (action.type) {
    case 'snapshot':
      return fromSnapshot(action.job, action.sentences);
    case 'sentence_done': {
      if (!state || action.revision < state.revision) return state;
      const prev = state.sentences[action.idx];
      const score = action.score ?? null;
      if (prev && prev.status === action.status && prev.score === score && action.revision === state.revision) return state;
      return {
        ...state,
        revision: Math.max(state.revision, action.revision),
        status: state.status === 'queued' ? 'running' : state.status,
        sentences: { ...state.sentences, [action.idx]: { status: action.status, score } },
        lastArrived: action.idx,
      };
    }
    case 'job_done':
      if (!state || action.revision < state.revision) return state;
      return { ...state, status: 'done', revision: action.revision, errorCode: null };
    case 'job_failed':
      if (!state) return state;
      return { ...state, status: action.status === 'canceled' ? 'canceled' : 'failed', errorCode: action.errorCode ?? null };
    case 'regenerate_started':
      if (!state) return state;
      return {
        ...state,
        status: 'queued',
        revision: action.revision,
        errorCode: null,
        sentences: { ...state.sentences, [action.idx]: { status: 'pending', score: null } },
        lastArrived: null,
      };
    default:
      return state;
  }
}
