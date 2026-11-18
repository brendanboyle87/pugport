import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './Studio';
import { ConfirmDialogHost } from './ConfirmDialog';
import { BankLinkDialog } from './BankLinkDialog';
import { UiUpdateNotice } from './UiUpdateNotice';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import '@fontsource-variable/jetbrains-mono';
import './studio.css';
import './SwarmWorkspace.css';
import './DelegationTree.css';
import './UiUpdateNotice.css';
import './AppUpdateNotice.css';
import './ConversationQueue.css';
import './SideChatPanel.css';
import './ConversationPanel.css';
import './ExecutorChecklist.css';
import './TasteTest.css';
import './Connectors.css';
import './ConversationFolders.css';
import './media-workflows.css';
import './pinned-messages.css';
import './SlackGateway.css';
import './composer.css';
import './ExternalAgents.css';
import './Devices.css';
import './StorePage.css';
import './mods/mods.css';
import './ConversationModeView.css';
import './conversation-work.css';
import './ConversationTrace.css';
import './TraceContext.css';
import './reply-versions.css';

import { startInterfaceLanguage } from './i18n';

// The language layer starts first, so the first frame already shows the chosen language.
void startInterfaceLanguage()
  .catch(() => undefined)
  .finally(() =>
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
        <ConfirmDialogHost />
        <BankLinkDialog />
        <UiUpdateNotice />
      </React.StrictMode>,
    ),
  );

import './settings.css';
import './AccountSettings.css';
import './ExtensionsHome.css';
import './StartChecklist.css';
import './ProblemReport.css';
