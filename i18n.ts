import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Locale = "es" | "fr" | "pt-BR";
type Key = keyof typeof fallback;
type Params = Record<string, string | number>;

const namespace = "pi-mermaid";

const fallback = {
	"notify.parserUnavailable": "Mermaid parser validation isn’t usable right now{suffix}. Will try again next time; rendering anyway.",
	"notify.tooManyBlocks": "Found {count} mermaid blocks, rendering first {max}.",
	"notify.blockTooLarge": "Mermaid block {index} too large ({lines} lines, {chars} chars).",
	"notify.unsupportedType": "pi-mermaid can't render type \"{type}\"{blockLabel}. Supported: {supported}.",
	"command.description": "Render mermaid in last assistant message as ASCII",
	"command.noAssistant": "No assistant message found",
	"command.noBlocks": "No mermaid blocks found",
} as const;

const translations: Record<Locale, Partial<Record<Key, string>>> = {
	es: {
		"notify.parserUnavailable": "La validación del parser de Mermaid no está disponible ahora{suffix}. Se intentará de nuevo la próxima vez; se renderizará de todos modos.",
		"notify.tooManyBlocks": "Se encontraron {count} bloques mermaid; se renderizarán los primeros {max}.",
		"notify.blockTooLarge": "El bloque Mermaid {index} es demasiado grande ({lines} líneas, {chars} caracteres).",
		"notify.unsupportedType": "pi-mermaid no puede renderizar el tipo \"{type}\"{blockLabel}. Compatible: {supported}.",
		"command.description": "Renderizar mermaid del último mensaje del asistente como ASCII",
		"command.noAssistant": "No se encontró ningún mensaje del asistente",
		"command.noBlocks": "No se encontraron bloques mermaid",
	},
	fr: {
		"notify.parserUnavailable": "La validation par le parseur Mermaid n’est pas disponible pour l’instant{suffix}. Nouvelle tentative la prochaine fois ; rendu quand même.",
		"notify.tooManyBlocks": "{count} blocs mermaid trouvés, rendu des {max} premiers.",
		"notify.blockTooLarge": "Le bloc Mermaid {index} est trop grand ({lines} lignes, {chars} caractères).",
		"notify.unsupportedType": "pi-mermaid ne peut pas afficher le type \"{type}\"{blockLabel}. Pris en charge : {supported}.",
		"command.description": "Afficher en ASCII le mermaid du dernier message assistant",
		"command.noAssistant": "Aucun message assistant trouvé",
		"command.noBlocks": "Aucun bloc mermaid trouvé",
	},
	"pt-BR": {
		"notify.parserUnavailable": "A validação do parser Mermaid não está disponível agora{suffix}. Tentará novamente na próxima vez; renderizando mesmo assim.",
		"notify.tooManyBlocks": "Encontrados {count} blocos mermaid; renderizando os primeiros {max}.",
		"notify.blockTooLarge": "O bloco Mermaid {index} é grande demais ({lines} linhas, {chars} caracteres).",
		"notify.unsupportedType": "pi-mermaid não consegue renderizar o tipo \"{type}\"{blockLabel}. Compatível: {supported}.",
		"command.description": "Renderizar mermaid da última mensagem do assistente como ASCII",
		"command.noAssistant": "Nenhuma mensagem do assistente encontrada",
		"command.noBlocks": "Nenhum bloco mermaid encontrado",
	},
};

let currentLocale: string | undefined;

function format(template: string, params: Params = {}): string {
	return template.replace(/\{(\w+)\}/g, (_match, key) => String(params[key] ?? `{${key}}`));
}

export function t(key: Key, params?: Params): string {
	const locale = currentLocale as Locale | undefined;
	const template = locale ? translations[locale]?.[key] : undefined;
	return format(template ?? fallback[key], params);
}

export function initI18n(pi: ExtensionAPI): void {
	pi.events?.emit?.("pi-core/i18n/registerBundle", {
		namespace,
		defaultLocale: "en",
		fallback,
		translations,
	});
	pi.events?.on?.("pi-core/i18n/localeChanged", (event: unknown) => {
		currentLocale = event && typeof event === "object" && "locale" in event
			? String((event as { locale?: unknown }).locale ?? "")
			: undefined;
	});
	pi.events?.emit?.("pi-core/i18n/requestApi", {
		namespace,
		onApi(api: { getLocale?: () => string | undefined }) {
			currentLocale = api.getLocale?.();
		},
	});
}
