import { resolveApiUrl } from '../../shared/api/httpClient'
import { Avatar } from '../../shared/components/Avatar'
import { CloseIcon, MicIcon, MicOffIcon } from '../../shared/components/Icons'

type Props = {
  otherUsername: string
  otherAvatar?: string | null
  duration: number
  isMuted: boolean
  status: 'outgoing' | 'active' | 'connecting'
  onToggleMute: () => void
  onHangup: () => void
}

// Sub-line under the peer name: the live timer once connected, otherwise a
// short status word for the ringing / doorbell-wait phases.
function statusLabel(status: Props['status'], duration: number): string {
  if (status === 'active') return formatDuration(duration)
  if (status === 'connecting') return 'Соединение...'
  return 'Вызов...'
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0')
  const s = (seconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

export function ActiveCallOverlay({ otherUsername, otherAvatar, duration, isMuted, status, onToggleMute, onHangup }: Props) {
  return (
    <div className="active-call-overlay">
      <div className="active-call-overlay__info">
        <Avatar
          name={otherUsername}
          avatarUrl={resolveApiUrl(otherAvatar)}
          size="sm"
          className="active-call-overlay__avatar"
        />
        <div className="active-call-overlay__text">
          <span className="active-call-overlay__name">{otherUsername}</span>
          <span className="active-call-overlay__status">
            {statusLabel(status, duration)}
          </span>
        </div>
      </div>
      <div className="active-call-overlay__controls">
        <button
          className={`active-call-overlay__btn${isMuted ? ' active-call-overlay__btn--active' : ''}`}
          onClick={onToggleMute}
          aria-label={isMuted ? 'Включить микрофон' : 'Выключить микрофон'}
        >
          {isMuted ? <MicOffIcon size={18} /> : <MicIcon size={18} />}
        </button>
        <button
          className="active-call-overlay__btn active-call-overlay__btn--hangup"
          onClick={onHangup}
          aria-label="Завершить звонок"
        >
          <CloseIcon size={18} />
        </button>
      </div>
    </div>
  )
}
