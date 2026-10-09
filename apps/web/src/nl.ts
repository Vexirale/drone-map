import type { ErrorCode, Role } from '@scan/shared';

/**
 * Every user-facing string of the staff app, in Dutch (nl-NL). Components contain no Dutch
 * literals: add new text here. Staff are addressed with "je" (customer pages use "u").
 */

/**
 * Friendly text for every machine error code the server can send (packages/shared ERROR_CODES).
 * Typed as a full Record, so adding a code in @scan/shared fails the typecheck until it gets text here.
 */
const errors: Record<ErrorCode, string> = {
  bad_request: 'Er klopt iets niet in wat je hebt ingevuld. Controleer het en probeer het opnieuw.',
  invalid_credentials: 'Het e-mailadres of wachtwoord klopt niet.',
  invalid_code: 'Deze code klopt niet of is verlopen. Vul de nieuwste code uit je app in.',
  rate_limited: 'Te veel pogingen achter elkaar. Wacht een paar minuten en probeer het dan opnieuw.',
  unauthenticated: 'Je bent niet meer ingelogd. Log opnieuw in.',
  second_factor_required: 'Vul eerst de code uit je authenticator-app in.',
  forbidden: 'Je hebt geen toegang tot dit onderdeel.',
  not_found: 'Dit onderdeel bestaat niet (meer).',
  conflict: 'Dit is intussen al gewijzigd. Vernieuw de pagina en probeer het opnieuw.',
  internal: 'Er ging iets mis op de server. Probeer het over een paar minuten opnieuw.',
};

const roles: Record<Role, string> = {
  admin: 'Beheerder',
  operator: 'Medewerker',
};

export const nl = {
  /** Browser tab title, for example "Opdrachten · Bedrijfsnaam". */
  pageTitle: (page: string, companyName: string) => `${page} · ${companyName}`,

  common: {
    loading: 'Laden…',
    retry: 'Opnieuw proberen',
    skipToContent: 'Naar de inhoud',
    on: 'Aan',
    off: 'Uit',
  },

  nav: {
    main: 'Hoofdmenu',
    jobs: 'Opdrachten',
    account: (name: string) => `Je account (${name})`,
    logout: 'Uitloggen',
    loggingOut: 'Uitloggen…',
  },

  login: {
    title: 'Inloggen',
    intro: 'Log in met je e-mailadres en wachtwoord.',
    email: 'E-mailadres',
    password: 'Wachtwoord',
    submit: 'Inloggen',
    submitting: 'Bezig met inloggen…',
    forgotPassword: 'Wachtwoord vergeten? Vraag de beheerder om een nieuw wachtwoord.',
  },

  totpCode: {
    title: 'Inlogcode',
    intro: 'Open de authenticator-app op je telefoon en vul de code van 6 cijfers in.',
    code: 'Code van 6 cijfers',
    submit: 'Bevestigen',
    submitting: 'Controleren…',
    cancel: 'Annuleren en uitloggen',
  },

  totpSetup: {
    title: 'Tweestapsverificatie instellen',
    introRequired: 'Als beheerder log je in met je wachtwoord én een code uit een app op je telefoon.',
    intro:
      'Scan de QR-code met een authenticator-app, zoals Google Authenticator of Microsoft Authenticator. Vul daarna de code van 6 cijfers in die de app laat zien.',
    loadingQr: 'QR-code wordt gemaakt…',
    qrLabel: 'QR-code om te scannen met je authenticator-app',
    manualEntry: 'Lukt scannen niet? Vul dan deze sleutel in de app in:',
    code: 'Code van 6 cijfers uit de app',
    submit: 'Aanzetten',
    submitting: 'Bezig met aanzetten…',
    cancel: 'Annuleren',
    logout: 'Uitloggen',
  },

  /** Shared by the code fields on the login code and the setup screen. */
  codeFormat: 'Vul de 6 cijfers uit je app in.',

  jobs: {
    title: 'Opdrachten',
    emptyTitle: 'Nog geen opdrachten',
    emptyText:
      'Hier komen straks je opdrachten, met de scans van vóór en na het werk, de video en de pagina voor de klant. Opdrachten aanmaken kan vanaf de volgende versie van de app.',
  },

  account: {
    title: 'Je account',
    name: 'Naam',
    email: 'E-mailadres',
    role: 'Rol',
    totp: 'Tweestapsverificatie',
    totpExplain:
      'Met tweestapsverificatie log je in met je wachtwoord én een code uit een app op je telefoon. Zo kan niemand inloggen met alleen je wachtwoord.',
    totpEnable: 'Tweestapsverificatie aanzetten',
    totpOn: 'Aan',
    passwordTitle: 'Wachtwoord wijzigen',
    currentPassword: 'Huidig wachtwoord',
    newPassword: 'Nieuw wachtwoord',
    newPasswordHint: 'Minstens 12 tekens. Een zin van een paar woorden is sterk en goed te onthouden.',
    confirmPassword: 'Herhaal het nieuwe wachtwoord',
    passwordMismatch: 'De twee nieuwe wachtwoorden zijn niet hetzelfde.',
    passwordTooShort: 'Het nieuwe wachtwoord moet minstens 12 tekens hebben.',
    wrongCurrentPassword: 'Je huidige wachtwoord klopt niet.',
    passwordSubmit: 'Wachtwoord opslaan',
    passwordSaving: 'Opslaan…',
    passwordSaved: 'Je wachtwoord is gewijzigd. Op andere apparaten ben je uitgelogd.',
    staffTitle: 'Medewerkers',
    staffIntro: 'Nieuwe accounts maak je voorlopig aan op de server met pnpm user:add.',
    staffEmpty: 'Er zijn nog geen andere accounts.',
    staffInactive: 'Uitgeschakeld',
    staffTotp: 'Tweestaps aan',
    staffNoTotp: 'Tweestaps uit',
    lastLogin: 'Laatst ingelogd',
    neverLoggedIn: 'Nog nooit ingelogd',
  },

  notFound: {
    title: 'Pagina niet gevonden',
    text: 'Deze pagina bestaat niet. Misschien is de link verouderd.',
    home: 'Naar Opdrachten',
  },

  crash: {
    title: 'Er ging iets mis',
    text: 'Laad de pagina opnieuw. Blijft het misgaan? Meld het dan bij de beheerder.',
    reload: 'Pagina opnieuw laden',
  },

  roles,
  errors,
  /** No answer from the server at all (offline, server down, proxy error). */
  networkError: 'Geen verbinding met de server. Controleer je internetverbinding en probeer het opnieuw.',
} as const;
