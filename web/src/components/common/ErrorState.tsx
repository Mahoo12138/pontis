import { Button, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { describeError } from '../../lib/errors';
import { tokens } from '../../styles/semantic-tokens.css';

interface ErrorStateProps {
  message?: string;
  /** The query error, so the reason survives: a contract mismatch and a dead server must not look the same. */
  error?: unknown;
  onRetry: () => void;
}

/** Query failure placeholder with a retry action. */
export default function ErrorState({ message, error, onRetry }: ErrorStateProps) {
  const { t } = useTranslation();
  const detail = describeError(error);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        minHeight: 160,
        color: tokens.textSecondary,
        gap: 8,
      }}
    >
      <IconAlertCircle size={32} stroke={1.2} style={{ color: tokens.syncError }} />
      <Text fz="sm">{message ?? t('error_generic')}</Text>
      {detail && (
        <Text
          component="span"
          fz="xs"
          c="dimmed"
          title={detail}
          style={{ maxWidth: 460, textAlign: 'center', overflowWrap: 'anywhere' }}
        >
          {detail.length > 200 ? `${detail.slice(0, 197)}…` : detail}
        </Text>
      )}
      <Button size="compact-xs" variant="subtle" color="coolGray" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}
