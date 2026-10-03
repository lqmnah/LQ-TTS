import { CheckCircleIcon, CircleNotchIcon, StopIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useI18n } from '../i18n/index.jsx';
import { StatusChip } from './ui.jsx';

const JOB = {
  queued: ['neutral', CircleNotchIcon, true],
  running: ['progress', CircleNotchIcon, true],
  done: ['success', CheckCircleIcon, false],
  failed: ['danger', WarningCircleIcon, false],
  canceled: ['neutral', StopIcon, false],
};

export function JobStatus({ status, testId }) {
  const { t } = useI18n();
  const key = JOB[status] ? status : 'queued';
  const [tone, Icon, spinning] = JOB[key];
  return <StatusChip tone={tone} icon={Icon} spinning={spinning} testId={testId} status={status}>{t(`job.status.${key}`)}</StatusChip>;
}

const SENTENCE = {
  pending: ['neutral', null, false],
  running: ['progress', CircleNotchIcon, true],
  done: ['success', CheckCircleIcon, false],
  needs_review: ['warning', WarningCircleIcon, false],
};

export function SentenceStatus({ status }) {
  const { t } = useI18n();
  const key = SENTENCE[status] ? status : 'pending';
  const [tone, Icon, spinning] = SENTENCE[key];
  return <StatusChip tone={tone} icon={Icon} spinning={spinning}>{t(`job.sentence.status.${key}`)}</StatusChip>;
}

const VOICE = {
  processing: ['progress', CircleNotchIcon, true],
  ready: ['success', CheckCircleIcon, false],
  failed: ['danger', WarningCircleIcon, false],
};

export function VoiceStatus({ status }) {
  const { t } = useI18n();
  const key = VOICE[status] ? status : 'processing';
  const [tone, Icon, spinning] = VOICE[key];
  return <StatusChip tone={tone} icon={Icon} spinning={spinning}>{t(`voices.status.${key}`)}</StatusChip>;
}
