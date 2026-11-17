// Every word the user reads lives in this file, so the plain-language rule is easy to check and change.
// No "listing", "workflow", "wallet", "x402", "n8n" or "API key" here: those are the Details toggle's business.

export const copy = {
  brand: { name: 'Zynd Studio', tagline: 'Build an agent by describing it.' },

  nav: { agents: 'Agents', signOut: 'Sign out', credit: 'Credit', account: 'Account' },

  signIn: {
    title: 'Welcome to Zynd Studio',
    body: 'Describe an agent in plain words, try it, and let other agents hire it.',
    google: 'Continue with Google',
    working: 'Setting up your space…',
    fine: 'We use your Google name and email to set up your space. Nothing else.',
    previewHint: 'This is a preview with sample data. No sign-in needed.',
    errors: {
      setup: 'We could not set up your space just now. Please try again in a minute.',
      callback: 'Google sign-in did not finish. Please try again.',
      denied: 'Google sign-in was cancelled.',
      config: 'Studio is not switched on yet. Please check back soon.',
    },
  },

  agents: {
    title: 'Your agents',
    subtitle: 'Agents you have built. Publish one to let other agents hire it.',
    create: 'Create agent',
    creditLeft: 'credit left',
    earned: 'earned',
    empty: {
      title: 'Build your first agent',
      body: 'Tell Studio what you need done. It finds helpers, builds the agent and tests it for you. Try one of these:',
    },
    ideas: [
      { title: 'Check a new supplier before I pay them', body: 'Looks up the company and screens its payment details for risk.' },
      { title: 'Summarise any web page for me', body: 'Send a link, get a short and honest summary back.' },
      { title: 'Tell me if a crypto address looks risky', body: 'Screens an address and explains the result in a few lines.' },
    ],
  },

  status: { draft: 'Draft', live: 'Live', paused: 'Paused' },

  create: {
    title: 'Create agent',
    chatTitle: 'Tell us what it should do',
    placeholder: 'For example: check a new supplier before I pay them…',
    send: 'Send',
    previewTitle: 'Your agent',
    previewEmpty: 'Your agent appears here as you describe it.',
    nameLabel: 'Name',
    doesLabel: 'What it does',
    helpersLabel: 'Helpers it uses',
    helpersNone: 'No helpers yet',
    costLabel: 'Cost per use',
    costNote: 'About what one use costs your agent in helpers.',
    stepsTitle: 'Progress',
    steps: ['Finding helpers', 'Building', 'Testing', 'Ready'],
    ready: 'Your agent is ready. Try it, then publish it when you are happy.',
    open: 'Open agent',
    notReady: 'The agent builder is not switched on yet. Please check back soon.',
    creditSent: (amount: string) => `Your agent starts with ${amount} of credit.`,
    creditNone: 'Your agent was created without starter credit, so it cannot hire helpers yet.',
    continueHint: 'Want a change? Just say what to adjust.',
    stop: 'Stop',
    activityTitle: 'What is happening',
    resume: 'Continue where you left off',
  },

  agent: {
    tabs: { chat: 'Chat', edit: 'Make changes', activity: 'Activity', settings: 'Settings' },
    publish: 'Publish',
    chatPlaceholder: 'Ask your agent something…',
    chatEmpty: 'Ask your agent something to try it out.',
    used: (helpers: number, cost: string) => `used ${helpers} ${helpers === 1 ? 'helper' : 'helpers'} · ${cost}`,
    usedNone: 'used no helpers · $0.00',
    details: 'Details',
    hideDetails: 'Hide details',
    working: 'Working on it…',
    activity: {
      title: 'Recent activity',
      you: 'You tried it',
      other: 'Another agent hired it',
      empty: 'Nothing here yet. Try your agent or publish it to see activity.',
      loadFailed: 'We could not load the recent activity just now. Please reload the page in a moment.',
      earned: (amount: string) => `earned ${amount}`,
      spent: (amount: string) => `cost ${amount}`,
      done: 'Done',
      failed: 'Did not finish',
    },
    settings: {
      title: 'Settings',
      name: 'Name',
      description: 'What it does',
      descriptionHelp: 'Shown to other agents. 200 characters at most.',
      price: 'Price per use',
      priceHelp: 'What another agent pays each time it hires yours.',
      save: 'Save changes',
      pause: 'Pause agent',
      pauseHelp: 'Other agents can no longer hire it. You can publish again any time.',
      delete: 'Delete agent',
      deleteHelp: 'Removes the agent for good.',
      deleteTitle: 'Delete this agent?',
      deleteBody: (credit: string) => `This cannot be undone. Any credit left on the agent (${credit}) is lost.`,
      deleteConfirm: 'Delete agent',
      cancel: 'Cancel',
    },
    notAvailable: 'This agent cannot be used from the app yet.',
    notBuilt: 'This agent has not been built yet.',
    finishBuilding: 'Finish building it',
    saved: 'Saved',
    paused: 'Your agent is paused.',
    deleted: 'Agent deleted.',
  },

  // Changing an agent that already exists (S4.1), on the agent page.
  edit: {
    chatTitle: 'What should change?',
    placeholder: 'For example: also check sanctions lists…',
    intro: 'Tell your agent what to change, in plain words. Studio makes the change and tests it.',
    introLive: 'Tell your agent what to change, in plain words. Studio makes the change and tests it. A change that passes its test goes live by itself, and your agent keeps working in the meantime.',
    steps: ['Finding helpers', 'Updating', 'Testing', 'Ready'],
    live: {
      updated: 'Done. Your live agent now uses this change.',
      held: 'Your live agent still uses its earlier version, because this change has not passed a test yet.',
      failed: 'We could not put this change live just now. Please send it again in a minute.',
    },
  },

  publish: {
    title: 'Publish your agent',
    body: 'Check how it will look to other agents. Once it is live, anyone can hire it for the price below.',
    name: 'Name',
    description: 'What it does',
    price: 'Price per use (USD)',
    confirm: 'Publish agent',
    cancel: 'Cancel',
    note: 'The name and description cannot be changed everywhere after publishing, so check them now.',
    done: 'Your agent is live.',
  },

  account: { signedInAs: 'Signed in as', totalCredit: 'Total credit', unknownCredit: 'Not available right now' },

  preview: { banner: 'Preview with sample data' },

  // Plain words and a next step for every error the user can meet (S4.2 uses these everywhere).
  /** S5.3: the agent taking shape, and what the builder is doing, as the person reads it. */
  /** S6: the live picture of what an agent does while it answers. */
  network: {
    title: 'Your agent\u2019s network',
    you: 'Your agent',
    creditLeft: 'credit left',
    idle: 'Ready. Ask a question and watch your agent get to work.',
    thinking: 'Thinking it through\u2026',
    searching: (query: string) => `Looking for help: \u201c${query}\u201d`,
    searchingPlain: 'Looking for someone who can help\u2026',
    found: (count: string) => `Found ${count} that could help`,
    foundNone: 'Found nobody suitable',
    talking: (name: string) => `Asking ${name}\u2026`,
    paid: (name: string, amount: string) => `Paid ${name} ${amount}`,
    paidNothing: (name: string) => `${name} answered`,
    failed: (name: string) => `${name} did not answer`,
    done: 'Answer ready',
    perUse: (amount: string) => `${amount} per use`,
    freeToAsk: 'price not shown',
    paidTotal: (amount: string) => `paid ${amount}`,
    uses: (n: string) => `${n} ${n === '1' ? 'time' : 'times'}`,
    spent: 'Paid in this chat',
    agentsMet: 'Helpers used',
    empty: 'Helpers your agent finds and pays will appear here.',
    show: 'Show the network',
    hide: 'Hide the network',
    candidate: 'Could help',
    yourTools: 'Its own helpers',
    log: 'What happened',
    ownHelper: 'Helper',
    dataSource: 'Data',
    webReader: 'Web',
    foundAgent: 'Found on the network',
  },

  build: {
    parts: {
      network: 'Other agents hire it',
      chat: 'You try it here',
      request: 'Reads the request',
      brain: 'Thinks it through',
      answer: 'Sends the answer',
      helper: 'Helper',
      source: 'Data source',
      web: 'Reads public web pages',
    },
    states: { planned: 'Planned', building: 'Building', ready: 'Ready', testing: 'Trying', used: 'Used', failed: 'Did not answer' },
    usesTitle: 'It can use',
    noTools: 'Answers from its own knowledge',
    perUse: (price: string) => `up to ${price} per use`,
    paid: (cost: string) => `paid ${cost}`,
    searching: (query: string) => `Searching the network for "${query}"`,
    found: (n: string) => (n === '1' ? 'Found 1 possible helper' : `Found ${n} possible helpers`),
    foundNone: 'No helpers matched: it can work without one',
    sources: (n: string) => `Looked at ${n} data sources`,
    planned: (name: string) => `Planned "${name}"`,
    described: (name: string) => `Updated the name and description of "${name}"`,
    saving: 'Putting your agent together',
    saved: 'Your agent is put together and saved',
    savingFailed: 'Could not put your agent together',
    reading: 'Looking at how your agent works now',
    changing: 'Making the change',
    changed: 'Change saved',
    trying: (question: string) => `Trying it: "${question}"`,
    answered: (question: string, seconds: string) => `Tried "${question}": it answered in ${seconds} s`,
    noAnswer: 'It did not answer',
    helperUsed: (name: string, cost: string) => `${name} answered · ${cost}`,
    helperSilent: (name: string) => `${name} did not answer`,
    switched: (name: string, how: string) => `${name} did not answer, so it now gets ${how}`,
    plainText: 'plain text',
    namedFields: 'named fields',
    leftOut: (name: string) => `${name} did not answer, so it was left out for now`,
    noCredit: 'Not tried: your agent has no credit for its helpers yet',
    ready: 'Ready',
  },

  errors: {
    outOfCredit: 'Your agent has run out of credit, so it cannot hire helpers right now. Credit top-ups are not available yet: please ask the Studio team to add some.',
    helperFailed: 'A helper did not answer. Please try again.',
    tookTooLong: 'This took too long. Please try again.',
    generic: 'Something went wrong on our side. Please try again in a moment.',
    unavailable: 'Studio could not reach one of its services just now. Please try again in a moment.',
    network: 'We could not reach Studio. Please check your connection and try again.',
    cutOff: 'This was interrupted before it finished. Your agent is saved: send your message again to carry on.',
    loadFailedTitle: 'This page did not load',
    loadFailed: 'We could not load this page just now. Please try again in a moment.',
    retry: 'Try again',
    notFound: 'We could not find that agent.',
    signedOut: 'Please sign in again to continue.',
    notBuilt: 'This agent has not been built yet. Finish building it first.',
    notReady: 'This agent is not finished yet. Open the builder to finish it.',
    notLive: 'This agent is not live.',
    limit: 'You have reached the most agents you can have. Delete one to make another.',
    registration: 'We could not put your agent on the network just now. Please try again in a minute.',
    badInput: 'Please check what you entered and try again.',
    notSwitchedOn: 'This is not switched on yet. Please check back soon.',
    forbidden: 'That did not come from Studio. Please reload the page and try again.',
    busy: 'Your agent is still being worked on. Please wait for it to finish.',
  },

  notFound: { title: 'Nothing here', body: 'That page does not exist, or it is not yours.', back: 'Back to your agents' },
} as const;

/** What a person reads for an error code from Studio's API. Never raw text. */
export function apiMessage(code: string | undefined, kind?: string): string {
  const e = copy.errors;
  if (kind === 'credit') return e.outOfCredit;
  if (kind === 'helper') return e.helperFailed;
  if (kind === 'timeout') return e.tookTooLong;
  switch (code) {
    case 'not-found':
      return e.notFound;
    case 'signed-out':
      return e.signedOut;
    case 'no-workflow':
      return e.notBuilt;
    case 'not-ready':
      return e.notReady;
    case 'not-live':
      return e.notLive;
    case 'limit':
      return e.limit;
    case 'registration':
      return e.registration;
    case 'bad-input':
      return e.badInput;
    case 'preview':
    case 'not-configured':
      return e.notSwitchedOn;
    case 'unavailable':
      return e.unavailable;
    case 'forbidden':
      return e.forbidden;
    case 'busy':
      return e.busy;
    default:
      return e.generic;
  }
}
