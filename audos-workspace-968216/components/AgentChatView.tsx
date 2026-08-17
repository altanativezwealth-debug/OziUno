/**
 * AgentChatView — per-space agent UI.
 *
 * THIS FILE IS THE PER-SPACE AGENT APPEARANCE. Edit it to restyle the agent
 * element (colors, spacing, copy, layout, message bubbles, header card,
 * suggestion chips, empty state, input bar, etc.). Your edits PERSIST across
 * recompiles.
 *
 * The runtime hook `useAgentChatRuntime` and the `AgentChat.tsx` shell are
 * platform-managed and force-overwritten on each compile — do not put any
 * logic / state / fetch / effect work in here. This view is purely
 * presentational; it consumes the runtime and renders.
 */
import { useRef, useState } from 'react';
import {
  Bot,
  Send,
  BookOpen,
  Edit3,
  Save,
  Sparkles,
  Loader2,
  FolderOpen,
  Search,
  ListChecks,
  Paperclip,
  Mic,
  Square,
  X,
  FileImage,
  File,
  XCircle,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getFriendlyTerm, getToolColor } from '../lib/friendly-terms';
import { tw } from '../lib/colors';
import type { AgentChatRuntime } from './useAgentChatRuntime';

interface AgentChatViewProps {
  runtime: AgentChatRuntime;
}

function WorkingIndicator({
  lastAction,
  agentLabel = 'Agent',
  thinkingText,
}: {
  lastAction?: string;
  agentLabel?: string;
  thinkingText?: string | null;
}) {
  const actionIcons: Record<string, any> = {
    read_file: BookOpen,
    write_file: Save,
    edit_file: Edit3,
    write_task_list: ListChecks,
    glob: Search,
    grep: Search,
    ls: FolderOpen,
  };

  const Icon = actionIcons[lastAction || ''] || Loader2;
  const friendlyText = getFriendlyTerm(lastAction || '', 'thinking');
  const color = getToolColor(lastAction || '');

  return (
    <div className="flex items-center justify-center py-2 mr-8">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--space-surface-muted)] rounded-full">
        <Icon className={`h-4 w-4 ${color} animate-spin`} />
        <span className={`text-xs font-medium ${color}`}>
          {thinkingText || `${agentLabel} is ${friendlyText}...`}
        </span>
      </div>
    </div>
  );
}

/**
 * VoiceCaptureButton — press to speak, press again to stop. The recording is
 * transcribed server-side (/api/generate/transcribe) and handed to the chat as
 * if the customer had typed it, so a spoken "NEPA bill due Friday" is logged
 * by the agent with zero typing. Self-contained on purpose: the platform
 * runtime hook is force-overwritten on compile, so mic state lives here.
 */
function VoiceCaptureButton({
  disabled,
  onTranscribed,
  onError,
}: {
  disabled: boolean;
  onTranscribed: (text: string) => void;
  onError?: (message: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef<any>(null);
  const chunksRef = useRef<Blob[]>([]);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType =
        typeof MediaRecorder !== 'undefined' && (MediaRecorder as any).isTypeSupported?.('audio/webm')
          ? 'audio/webm'
          : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e: any) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size < 200) return;
        setTranscribing(true);
        try {
          const formData = new FormData();
          formData.append('audio', blob, 'voice-note.webm');
          const res = await fetch('/api/generate/transcribe', { method: 'POST', body: formData });
          if (!res.ok) throw new Error('Transcription failed');
          const { text } = await res.json();
          if (text && text.trim()) {
            onTranscribed(text.trim());
          } else {
            onError?.("Didn't catch that — try speaking again, a little closer to the mic.");
          }
        } catch {
          onError?.('Could not transcribe that recording — you can type it instead.');
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start();
      setRecording(true);
    } catch {
      onError?.('Microphone access was blocked. Allow it in your browser settings, or type instead.');
    }
  };

  const stop = () => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.stop();
    }
    setRecording(false);
  };

  return (
    <button
      type="button"
      onClick={recording ? stop : start}
      disabled={disabled || transcribing}
      className={`h-8 w-8 flex items-center justify-center rounded-xl transition-colors ${
        recording
          ? 'bg-[var(--space-semantic-danger)] text-white animate-pulse'
          : 'hover:bg-[var(--space-surface-muted)]'
      } disabled:opacity-50 disabled:cursor-not-allowed`}
      title={recording ? 'Stop and send' : 'Speak to OziUno'}
      data-testid="button-voice-capture"
    >
      {transcribing ? (
        <Loader2 className="w-4 h-4 animate-spin text-[var(--space-text-muted)]" />
      ) : recording ? (
        <Square className="w-4 h-4" />
      ) : (
        <Mic className="w-4 h-4 text-[var(--space-text-muted)]" />
      )}
    </button>
  );
}

// react-markdown strips its internal `node` prop from the rest spread when
// destructured, which keeps it from leaking onto DOM elements.
const SAFE_MARKDOWN_PROTOCOLS = /^(subscribe|app|https?|mailto|tel|ircs?|xmpp):/i;

const markdownUrlTransform = (value: string): string => {
  if (typeof value === 'string' && SAFE_MARKDOWN_PROTOCOLS.test(value)) {
    return value;
  }

  const colon = value.indexOf(':');
  const slash = value.indexOf('/');
  const question = value.indexOf('?');
  const hash = value.indexOf('#');

  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (question !== -1 && colon > question) ||
    (hash !== -1 && colon > hash)
  ) {
    return value;
  }

  return '';
};

const markdownComponents: Components = {
  p({ node: _node, children, ...props }) {
    return (
      <p className="my-2 text-base" {...props}>
        {children}
      </p>
    );
  },
  ul({ node: _node, children, ...props }) {
    return (
      <ul
        className="my-3 pl-5 space-y-1"
        style={{ listStyleType: 'disc', listStylePosition: 'outside' }}
        {...props}
      >
        {children}
      </ul>
    );
  },
  ol({ node: _node, children, ...props }) {
    return (
      <ol
        className="my-3 pl-5 space-y-1"
        style={{ listStyleType: 'decimal', listStylePosition: 'outside' }}
        {...props}
      >
        {children}
      </ol>
    );
  },
  li({ node: _node, children, ...props }) {
    return (
      <li className="ml-0 text-base" style={{ display: 'list-item' }} {...props}>
        {children}
      </li>
    );
  },
  table({ node: _node, children, ...props }) {
    return (
      <div className="overflow-x-auto my-3">
        <table
          className="min-w-full border-collapse border border-[var(--space-border-strong)] text-sm"
          {...props}
        >
          {children}
        </table>
      </div>
    );
  },
  thead({ node: _node, children, ...props }) {
    return (
      <thead className="bg-[var(--space-surface-muted)]" {...props}>
        {children}
      </thead>
    );
  },
  tbody({ node: _node, children, ...props }) {
    return <tbody {...props}>{children}</tbody>;
  },
  tr({ node: _node, children, ...props }) {
    return (
      <tr className="border-b border-[var(--space-border-default)]" {...props}>
        {children}
      </tr>
    );
  },
  th({ node: _node, children, ...props }) {
    return (
      <th
        className="border border-[var(--space-border-strong)] px-3 py-2 text-left font-semibold"
        {...props}
      >
        {children}
      </th>
    );
  },
  td({ node: _node, children, ...props }) {
    return (
      <td className="border border-[var(--space-border-strong)] px-3 py-2" {...props}>
        {children}
      </td>
    );
  },
  code({ node: _node, children, className, ...props }) {
    const isBlock = typeof className === 'string' && className.includes('language-');
    if (isBlock) {
      return (
        <code className={`${className ?? ''} break-all`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="bg-[var(--space-neutral-800)] text-[var(--space-neutral-100)] px-1.5 py-0.5 rounded text-sm break-all"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre({ node: _node, children, ...props }) {
    return (
      <pre
        className="bg-[var(--space-neutral-800)] text-[var(--space-neutral-100)] rounded-lg p-3 my-2 overflow-x-auto max-w-full"
        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
        {...props}
      >
        {children}
      </pre>
    );
  },
  a({ node: _node, href, children }) {
    if (typeof href === 'string' && href.startsWith('app://')) {
      const appId = href.replace('app://', '');
      return (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[AgentChat] Button click - opening app:', appId);
            window.dispatchEvent(new CustomEvent('openApp', { detail: { appId } }));
          }}
          className={`inline-flex items-center gap-1 px-3 py-1 ${tw.button.primary} rounded-lg transition-colors text-xs font-medium mx-1`}
          data-testid={`link-app-${appId}`}
        >
          {children}
        </button>
      );
    }
    if (typeof href === 'string' && href.startsWith('subscribe://')) {
      return (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            window.dispatchEvent(new CustomEvent('endIntroSession'));
          }}
          className="text-[var(--space-text-brand)] hover:underline break-all bg-transparent border-none p-0 font-inherit text-left"
          data-testid="link-subscribe-plans"
        >
          {children}
        </button>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={href}
        className="text-[var(--space-text-brand)] hover:underline break-all"
      >
        {children}
      </a>
    );
  },
};

export default function AgentChatView({ runtime }: AgentChatViewProps) {
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const {
    messages,
    streamingContent,
    isStreaming,
    loading,
    lastAction,
    isLoadingHistory,
    hasLoadedHistory,
    input,
    setInput,
    pendingAttachments,
    isUploadingAttachment,
    isDraggingOver,
    messagesEndRef,
    textareaRef,
    fileInputRef,
    dropZoneRef,
    abortStream,
    sendMessage,
    sendMessageWithContent,
    removeAttachment,
    handleFileSelect,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePaste,
    handleKeyDown,
    greetingPrompt,
    isConfigLoaded,
    greetingSent,
    welcomeInjectedSource,
    isBeaconSpace,
    agentLabel,
    thinkingText,
    beaconIntake,
    beaconStarterPrompts,
    starterPrompts,
    shortcutPrefix,
  } = runtime;

  const hasUserMessages = messages.some((message) => message.role === 'user');
  const shouldShowBeaconIntake = isBeaconSpace && !!beaconIntake && !hasUserMessages;
  const composerPlaceholder = pendingAttachments.length > 0
    ? isBeaconSpace
      ? 'Add any context about these files...'
      : 'Add a message about the files...'
    : isBeaconSpace
      ? shouldShowBeaconIntake
        ? 'We can keep building from your starter plan, or you can tell me what changed...'
        : "Tell me what happened, or what you're worried about..."
      : 'Speak or type — "Jake\'s dentist is Thursday at 3pm"…';

  const visibleMessages = messages.filter(
    (m) => !(m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[SYSTEM:')),
  );

  const isPending =
    isLoadingHistory ||
    !isConfigLoaded ||
    (!!greetingPrompt && !greetingSent) ||
    (greetingSent && !welcomeInjectedSource);

  const showPendingPlaceholder =
    visibleMessages.length === 0 &&
    !loading &&
    !streamingContent &&
    !shouldShowBeaconIntake &&
    isPending;

  const showEmptyStateWelcome =
    !isLoadingHistory &&
    hasLoadedHistory &&
    isConfigLoaded &&
    visibleMessages.length === 0 &&
    !greetingSent &&
    !greetingPrompt &&
    !shouldShowBeaconIntake;

  // Conversation-starter chips must be visible in the INITIAL state even when a
  // welcome assistant message has been injected (config.agent.welcomeMessage),
  // which makes visibleMessages non-empty and turns showEmptyStateWelcome off.
  // Gate on "no user messages yet" instead so the starters stay clickable until
  // the visitor sends their first message.
  const showStarterPromptsBelowWelcome =
    !isBeaconSpace &&
    !showEmptyStateWelcome &&
    !isLoadingHistory &&
    hasLoadedHistory &&
    isConfigLoaded &&
    !hasUserMessages &&
    !shouldShowBeaconIntake &&
    !loading &&
    !streamingContent &&
    starterPrompts.length > 0;

  const isHomeView =
    !isBeaconSpace &&
    !hasUserMessages &&
    hasLoadedHistory &&
    !isLoadingHistory &&
    isConfigLoaded &&
    !loading &&
    !streamingContent &&
    !shouldShowBeaconIntake &&
    !isPending;

  const firstAssistantMessage = visibleMessages.find((m) => m.role === 'assistant');
  const homeWelcomeText =
    typeof firstAssistantMessage?.content === 'string' && firstAssistantMessage.content.length <= 260
      ? firstAssistantMessage.content
      : '';

  const composerElement = (
    <>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          accept="image/*,application/pdf"
          multiple
          className="hidden"
          data-testid="input-file-attachment"
        />

        <div
          ref={dropZoneRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`rounded-2xl border transition-all overflow-hidden shadow-[0_8px_28px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.05)] focus-within:shadow-[0_10px_34px_rgba(0,0,0,0.11),0_1px_3px_rgba(0,0,0,0.05)] ${
            isDraggingOver
              ? 'border-[var(--space-brand-primary-500)] bg-[var(--space-surface-accent-soft)]'
              : 'border-[var(--space-border-default)] bg-[var(--space-surface-card)]'
          }`}
        >
          {isDraggingOver && (
            <div className="flex items-center justify-center py-3 px-4 bg-[var(--space-surface-accent-soft)] border-b border-[var(--space-border-default)]">
              <FileImage className="w-4 h-4 text-[var(--space-text-brand)] mr-2" />
              <span className="text-sm text-[var(--space-text-brand)] font-medium">Drop files here</span>
            </div>
          )}

          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-2">
              {pendingAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="relative flex items-center gap-1 px-2 py-1 bg-[var(--space-surface-card)] rounded-lg text-xs border border-[var(--space-border-default)]"
                  data-testid={`attachment-preview-${attachment.id}`}
                >
                  {attachment.contentType.startsWith('image/') ? (
                    <FileImage className="w-3 h-3 text-[var(--space-text-brand)]" />
                  ) : (
                    <File className="w-3 h-3 text-[var(--space-text-muted)]" />
                  )}
                  <span className="max-w-[100px] truncate text-[var(--space-text-secondary)]">
                    {attachment.originalName}
                  </span>
                  <button
                    onClick={() => removeAttachment(attachment.id)}
                    className="ml-1 text-[var(--space-text-muted)] hover:text-[var(--space-semantic-danger)]"
                    data-testid={`button-remove-attachment-${attachment.id}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={composerPlaceholder}
            className="w-full border-0 bg-transparent px-4 py-3 text-sm focus:outline-none focus:ring-0 resize-none leading-5"
            rows={1}
            disabled={loading}
            data-testid="textarea-instruction"
          />

          <div className="flex items-center justify-between px-2 pb-1">
            <div className="flex items-center gap-1">
              <VoiceCaptureButton
                disabled={loading}
                onTranscribed={(text) => {
                  setVoiceError(null);
                  void sendMessageWithContent(text, []);
                }}
                onError={(message) => setVoiceError(message)}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={loading || isUploadingAttachment || pendingAttachments.length >= 5}
                className="h-8 w-8 flex items-center justify-center rounded-xl hover:bg-[var(--space-surface-muted)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                data-testid="button-attach-file"
                title="Attach files (images, PDFs)"
              >
                {isUploadingAttachment ? (
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--space-text-muted)]" />
                ) : (
                  <Paperclip className="w-4 h-4 text-[var(--space-text-muted)]" />
                )}
              </button>
            </div>

            <button
              onClick={loading ? abortStream : sendMessage}
              disabled={(!input.trim() && pendingAttachments.length === 0) && !loading}
              className={`h-8 w-8 flex items-center justify-center rounded-xl transition-colors ${
                loading
                  ? 'bg-[var(--space-semantic-danger-500)] hover:bg-[var(--space-semantic-danger-600)] text-[var(--space-text-on-primary)]'
                  : `${tw.button.primary} disabled:opacity-50 disabled:cursor-not-allowed`
              }`}
              data-testid="button-send-message"
            >
              {loading ? <XCircle className="w-4 h-4" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
        {voiceError && (
          <p className="text-xs mt-1.5 text-[var(--space-semantic-danger)]" data-testid="text-voice-error">
            {voiceError}
          </p>
        )}
    </>
  );

  return (
    <div
      className={`h-full flex flex-col ${
        isBeaconSpace
          ? 'bg-gradient-to-br from-[var(--space-surface-gradient-from)] via-[var(--space-surface-gradient-via)] to-[var(--space-surface-gradient-to)]'
          : 'bg-[var(--space-surface-card)]'
      }`}
    >
      {isHomeView ? (
        /* Home view — centered greeting + composer, like a fresh assistant session */
        <div className="flex-1 overflow-y-auto flex flex-col justify-center">
          <div className="mx-auto w-full max-w-2xl px-6 sm:px-10 py-10" data-testid="home-view">
            <div className="text-center mb-8">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--space-surface-accent-soft)] shadow-sm">
                <Bot className="h-6 w-6 text-[var(--space-text-brand)]" />
              </div>
              <h1 className="text-2xl font-semibold text-[var(--space-text-primary)]">What's happening at home?</h1>
              {homeWelcomeText && (
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--space-text-secondary)]">{homeWelcomeText}</p>
              )}
            </div>
            {composerElement}
            {starterPrompts.length > 0 && (
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {starterPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => { void sendMessageWithContent(prompt, []); }}
                    className="rounded-full border border-[var(--space-border-default)] bg-[var(--space-surface-card)] px-4 py-2 text-sm font-medium text-[var(--space-text-primary)] shadow-sm transition hover:border-[var(--space-border-strong)] hover:bg-[var(--space-surface-accent-soft)]"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
      <>
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl px-6 sm:px-10 py-6 space-y-4">
        {/* Pending-init placeholder so the user never sees a blank chat */}
        {showPendingPlaceholder && (
          <div className="flex justify-start mr-8">
            <div className="bg-[var(--space-surface-muted)] rounded-lg px-4 py-2 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-[var(--space-text-muted)]" />
              <span className="text-xs text-[var(--space-text-muted)]">Getting ready…</span>
            </div>
          </div>
        )}

        {!isLoadingHistory && hasLoadedHistory && shouldShowBeaconIntake && beaconIntake && (
          <div className="px-4">
            <div className="mx-auto max-w-2xl overflow-hidden rounded-3xl border border-[var(--space-semantic-success-100)] bg-[var(--space-surface-card)] shadow-sm">
              <div className="border-b border-[var(--space-semantic-success-100)] bg-gradient-to-r from-[var(--space-semantic-success-50)] via-[var(--space-surface-card)] to-[var(--space-surface-accent-soft)] px-6 py-5">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--space-semantic-success-700)]">
                  Your Beacon starting point
                </p>
                <h2 className="mt-2 text-xl font-semibold text-[var(--space-text-primary)]">
                  {beaconIntake.headline}
                </h2>
                <p className="mt-2 text-sm leading-6 text-[var(--space-text-secondary)]">{beaconIntake.reflection}</p>
              </div>

              <div className="space-y-5 px-6 py-5">
                <div className="rounded-2xl border border-[var(--space-semantic-success-100)] bg-[var(--space-semantic-success-50)] px-4 py-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--space-semantic-success-700)]">
                    Today's anchor
                  </p>
                  <p className="mt-2 text-sm leading-6 text-[var(--space-text-secondary)]">{beaconIntake.anchor}</p>
                </div>

                <div>
                  <p className="text-sm font-semibold text-[var(--space-text-primary)]">Good next steps</p>
                  <div className="mt-3 space-y-2">
                    {beaconIntake.nextSteps.map((step) => (
                      <div
                        key={step}
                        className="flex items-start gap-3 rounded-2xl bg-[var(--space-surface-muted)] px-4 py-3 text-sm text-[var(--space-text-secondary)]"
                      >
                        <div className="mt-0.5 h-2 w-2 rounded-full bg-[var(--space-semantic-success-600)]" />
                        <span>{step}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-sm font-semibold text-[var(--space-text-primary)]">Continue from here</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {beaconIntake.starterPrompts.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => {
                          void sendMessageWithContent(prompt, []);
                        }}
                        className="rounded-full border border-[var(--space-semantic-success-100)] bg-[var(--space-surface-card)] px-4 py-2 text-sm font-medium text-[var(--space-semantic-success-700)] shadow-sm transition hover:border-[var(--space-semantic-success-500)] hover:bg-[var(--space-semantic-success-50)]"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Welcome message - only shown when confirmed no history exists */}
        {showEmptyStateWelcome ? (
          <div className="mt-8 px-4">
            {isBeaconSpace ? (
              <div className="mx-auto max-w-xl rounded-3xl border border-[var(--space-semantic-success-100)] bg-gradient-to-b from-[var(--space-semantic-success-50)] via-[var(--space-surface-card)] to-[var(--space-surface-card)] px-6 py-8 text-center shadow-sm">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--space-semantic-success-700)] text-[var(--space-text-on-primary)] shadow-sm">
                  <Bot className="h-6 w-6" />
                </div>
                <h2 className="text-xl font-semibold text-[var(--space-text-primary)]">Start with the hard part</h2>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--space-text-secondary)]">
                  Tell Beacon what happened, what conversation you are dreading, or what you need help saying next.
                </p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {beaconStarterPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => {
                        void sendMessageWithContent(prompt, []);
                      }}
                      className="rounded-full border border-[var(--space-semantic-success-100)] bg-[var(--space-surface-card)] px-4 py-2 text-sm font-medium text-[var(--space-semantic-success-700)] shadow-sm transition hover:border-[var(--space-semantic-success-500)] hover:bg-[var(--space-semantic-success-50)]"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-center text-[var(--space-text-secondary)]">
                <Bot className="w-12 h-12 mx-auto mb-3 text-[var(--space-text-muted)]" />
                <p className="text-sm">Tell OziUno anything about your household — it remembers, sorts it, and briefs you every morning</p>
                {starterPrompts.length > 0 && (
                  <div className="mt-5 flex flex-wrap justify-center gap-2">
                    {starterPrompts.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => {
                          void sendMessageWithContent(prompt, []);
                        }}
                        className="rounded-full border border-[var(--space-border-default)] bg-[var(--space-surface-card)] px-4 py-2 text-sm font-medium text-[var(--space-text-primary)] shadow-sm transition hover:border-[var(--space-border-strong)] hover:bg-[var(--space-surface-accent-soft)]"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          visibleMessages.length > 0 &&
          visibleMessages.map((msg, idx) => (
            <div key={idx}>
              <div
                className={`p-3 rounded-lg overflow-hidden min-w-0 ${
                  msg.role === 'user' ? `${tw.message.user} ml-8` : `${tw.message.assistant} mr-8`
                }`}
              >
                <p className="text-sm font-medium mb-1">
                  {isBeaconSpace
                    ? msg.role === 'assistant'
                      ? 'Beacon'
                      : 'You'
                    : msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}
                </p>

                {msg.role === 'user' && msg.attachments && msg.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {msg.attachments.map((att) => (
                      <div
                        key={att.id}
                        className="flex items-center gap-1 px-2 py-1 bg-[var(--space-surface-card)] rounded text-xs"
                      >
                        {att.contentType.startsWith('image/') ? (
                          <FileImage className="w-3 h-3 text-[var(--space-text-brand)]" />
                        ) : (
                          <File className="w-3 h-3 text-[var(--space-text-muted)]" />
                        )}
                        <span className="max-w-[100px] truncate">{att.originalName}</span>
                      </div>
                    ))}
                  </div>
                )}

                {typeof msg.content === 'string' || msg.content == null ? (
                  <div
                    className={`prose prose-base max-w-none ${
                      msg.role === 'user' ? 'text-base' : 'text-base'
                    }`}
                  >
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={markdownComponents}
                      urlTransform={markdownUrlTransform}
                    >
                      {typeof msg.content === 'string' ? msg.content : ''}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(Array.isArray(msg.content) ? msg.content : []).map((chunk, chunkIdx) => (
                      <div key={chunkIdx}>
                        {chunk.type === 'text' && chunk.text && (
                          <div className="prose prose-base max-w-none text-base">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={markdownComponents}
                              urlTransform={markdownUrlTransform}
                            >
                              {chunk.text}
                            </ReactMarkdown>
                          </div>
                        )}
                        {chunk.type === 'tool_use' && (
                          <div className="border border-[var(--space-border-strong)] rounded-lg overflow-hidden mt-2">
                            <div className="bg-[var(--space-surface-muted)] px-3 py-2 flex items-center gap-2 flex-wrap">
                              {chunk.name === 'edit_file' ? (
                                <Edit3 className="w-3.5 h-3.5 text-[var(--space-text-brand)]" />
                              ) : chunk.name === 'read_file' ? (
                                <BookOpen className="w-3.5 h-3.5 text-[var(--space-text-brand)]" />
                              ) : chunk.name === 'write_file' ? (
                                <Save className="w-3.5 h-3.5 text-[var(--space-semantic-success)]" />
                              ) : (
                                <Sparkles className="w-3.5 h-3.5 text-[var(--space-text-secondary)]" />
                              )}
                              <span className="text-xs font-semibold text-[var(--space-text-secondary)]">
                                {chunk.name === 'read_file'
                                  ? 'Viewing'
                                  : chunk.name === 'write_file'
                                    ? 'Creating'
                                    : chunk.name === 'edit_file'
                                      ? 'Updating'
                                      : getFriendlyTerm(chunk.name || '', 'Tool Use')}
                              </span>
                              {chunk.input?.file_path && (
                                <span className="font-mono text-xs text-[var(--space-text-secondary)] break-all">
                                  {chunk.input.file_path}
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))
        )}

        {showStarterPromptsBelowWelcome && (
          <div className="px-4 -mt-1">
            <p className="mb-2 text-xs font-medium text-[var(--space-text-muted)]">
              Try one of these to get started:
            </p>
            <div className="flex flex-wrap gap-2">
              {starterPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => {
                    void sendMessageWithContent(prompt, []);
                  }}
                  className="rounded-full border border-[var(--space-border-default)] bg-[var(--space-surface-card)] px-4 py-2 text-sm font-medium text-[var(--space-text-primary)] shadow-sm transition hover:border-[var(--space-border-strong)] hover:bg-[var(--space-surface-accent-soft)]"
                  data-testid={`starter-prompt-${prompt.slice(0, 24)}`}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {loading && !streamingContent && (
          <WorkingIndicator lastAction={lastAction} agentLabel={agentLabel} thinkingText={thinkingText} />
        )}

        {streamingContent && (
          <div
            className={`${isBeaconSpace ? 'bg-[var(--space-surface-card)] border border-[var(--space-semantic-success-100)] shadow-sm' : 'bg-[var(--space-surface-panel)]'} mr-8 p-3 rounded-lg overflow-hidden min-w-0`}
          >
            <p className="text-sm font-medium mb-1">{agentLabel}</p>
            <div className="prose prose-base max-w-none text-base">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
                urlTransform={markdownUrlTransform}
              >
                {streamingContent}
              </ReactMarkdown>
              {isStreaming && (
                <span className="inline-block w-0.5 h-4 ml-1 bg-[var(--space-text-primary)] animate-pulse" />
              )}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input area — floating composer, detached from the bottom edge */}
      <div className="px-4 sm:px-8 pb-5 pt-2">
        <div className="mx-auto w-full max-w-3xl">
        {composerElement}

        <p className="text-[10px] text-[var(--space-text-muted)] mt-1.5 text-center leading-tight">
          {shortcutPrefix}+Enter to send
        </p>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
