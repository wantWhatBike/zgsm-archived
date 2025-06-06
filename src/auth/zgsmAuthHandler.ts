import { defaultAuthConfig } from "./../../webview-ui/src/config/auth"
import * as vscode from "vscode"
import { ClineProvider } from "../core/webview/ClineProvider"
import { ApiConfiguration, zgsmProviderKey } from "../shared/api"
import * as os from "os"
import * as querystring from "querystring"
import { getZgsmModels } from "../api/providers/zgsm"
import { logger } from "../utils/logging"
import delay from "delay"

/**
 * Get local IP address
 * @returns Local IP address, or an empty string if not found
 */
function getLocalIP(): string {
	try {
		const interfaces = os.networkInterfaces()
		let ipAddress = ""

		for (const interfaceName in interfaces) {
			const networkInterface = interfaces[interfaceName]
			if (!networkInterface) continue

			for (const iface of networkInterface) {
				// Filter for IPv4 and non-internal addresses
				if (iface.family === "IPv4" && !iface.internal) {
					ipAddress = iface.address
					break
				}
			}
			if (ipAddress) break // Exit after finding the first valid IP
		}

		return ipAddress || ""
	} catch (error) {
		console.error("Failed to get local IP:", error)
		return ""
	}
}

/**
 * Create request headers with client identification information
 * @param dict Additional request header information
 * @returns Complete request header object
 */
export function createHeaders(dict: Record<string, any> = {}): Record<string, any> {
	// Get extended information
	const extension =
		vscode.extensions.getExtension("zgsm-ai.zgsm") || vscode.extensions.getExtension("rooveterinaryinc.roo-cline")
	const extVersion = extension?.packageJSON.version || ""
	const ideVersion = vscode.version || ""
	const hostIp = getLocalIP()

	const headers = {
		ide: "vscode",
		"ide-version": extVersion,
		"ide-real-version": ideVersion,
		"host-ip": hostIp,
		...dict,
	}
	return headers
}

/**
 * Handle ZGSM OAuth callback
 * @param code Authorization code
 * @param state State value
 * @param token Direct token if available
 * @param provider ClineProvider instance
 */
export async function handleZgsmAuthCallback(
	code: string | null,
	state: string | null,
	token: string | null,
	provider: ClineProvider,
): Promise<void> {
	logger.info(`handleZgsmAuthCallback: code: ${code}, state: ${state}, token: ${token}`)

	if (token) {
		await handleZgsmAuthCallbackWithToken(token, provider)
	} else if (code && state) {
		await handleZgsmAuthCallbackWithCode(code, state, provider)
	} else {
		logger.error(`gsm login: Invalid authentication parameters: code: ${code}, state: ${state}, token: ${token}`)
		vscode.window.showErrorMessage("zgsm login error: invalid callback params")
	}
}

/**
 * Handle ZGSM OAuth callback with token
 * @param token Access token
 * @param provider ClineProvider instance
 */
async function handleZgsmAuthCallbackWithToken(token: string, provider: ClineProvider): Promise<void> {
	try {
		const { apiConfiguration, currentApiConfigName } = await provider.getState()

		if (apiConfiguration) {
			const updatedConfig: ApiConfiguration = {
				...apiConfiguration,
				zgsmBaseUrl: apiConfiguration.zgsmBaseUrl || "",
				apiProvider: zgsmProviderKey,
				zgsmApiKey: token,
			}

			await updateAllConfigs(provider, currentApiConfigName, updatedConfig)

			await handleAfterLogin(updatedConfig, provider, token)

			vscode.window.showInformationMessage("zgsm login successful")
		} else {
			logger.error(`zgsm login failed: failed to get apiConfiguration`)
			vscode.window.showErrorMessage("zgsm login failed: failed to get apiConfiguration")
		}
	} catch (error) {
		logger.error("zgsm login error", error)
		vscode.window.showErrorMessage(`zgsm login error: ${error}`)
	}
}

/**
 * Handle ZGSM OAuth callback with authorization code
 * @param code Authorization code
 * @param state State value
 * @param provider ClineProvider instance
 */
export async function handleZgsmAuthCallbackWithCode(
	code: string,
	state: string,
	provider: ClineProvider,
): Promise<void> {
	try {
		const { apiConfiguration, currentApiConfigName } = await provider.getState()
		const tokenResponse = await getAccessToken(code, {
			...apiConfiguration,
			zgsmBaseUrl: apiConfiguration.zgsmBaseUrl || defaultAuthConfig.baseUrl,
			apiProvider: zgsmProviderKey,
		})

		if (tokenResponse.status === 200 && tokenResponse.data && tokenResponse.data.access_token) {
			const tokenData = tokenResponse.data

			if (apiConfiguration) {
				const updatedConfig: ApiConfiguration = {
					...apiConfiguration,
					zgsmBaseUrl: apiConfiguration.zgsmBaseUrl || "",
					apiProvider: zgsmProviderKey,
					zgsmApiKey: tokenData.access_token,
				}

				await updateAllConfigs(provider, currentApiConfigName, updatedConfig)

				await handleAfterLogin(updatedConfig, provider, tokenData.access_token)

				vscode.window.showInformationMessage("zgsm login successful")
			} else {
				logger.error(`zgsm login failed: failed to get apiConfiguration`)
				vscode.window.showErrorMessage("zgsm login err: failed to get token")
			}
		} else {
			logger.error(`zgsm login failed: url: ${apiConfiguration.zgsmBaseUrl}, resp: ${tokenResponse}`)
			vscode.window.showErrorMessage("zgsm login failed: failed to get token")
		}
	} catch (error) {
		logger.error("zgsm login failed", error)
		vscode.window.showErrorMessage(`zgsm login failed: ${error}`)
	}
}

/**
 * updateAllConfigs
 * @param provider: ClineProvider
 * @param acurrentApiConfigName: string
 * @param updatedConfig: ApiConfiguration
 */
async function updateAllConfigs(
	provider: ClineProvider,
	currentApiConfigName: string,
	updatedConfig: ApiConfiguration,
): Promise<void> {
	await provider.updateApiConfiguration(updatedConfig)

	const listApiConfig = (await provider.providerSettingsManager.listConfig()).filter(
		(config) => config.apiProvider === zgsmProviderKey,
	)

	const configUpdatesPromise = [provider.upsertApiConfiguration(currentApiConfigName, updatedConfig)]

	for (const configInfo of listApiConfig) {
		if (configInfo.name === currentApiConfigName) continue
		configUpdatesPromise.push(provider.upsertApiConfiguration(configInfo.name, updatedConfig))
	}

	await Promise.all(configUpdatesPromise)
}

/**
 * 处理登录成功后的操作
 */
async function handleAfterLogin(
	apiConfiguration: ApiConfiguration,
	provider: ClineProvider,
	accessToken: string,
): Promise<void> {
	try {
		const [zgsmModels, zgsmDefaultModelId] = await getZgsmModels(
			apiConfiguration.zgsmBaseUrl || defaultAuthConfig.baseUrl,
			accessToken,
			apiConfiguration.openAiHostHeader,
		)

		await provider.updateApiConfiguration({
			...apiConfiguration,
			zgsmModelId: zgsmDefaultModelId,
			zgsmDefaultModelId,
		})

		provider.postMessageToWebview({ type: "zgsmModels", zgsmModels, zgsmDefaultModelId })
	} catch (error) {
		logger.error("Failed to get ZGSM models:", error)
	}
}

/**
 * Handle ZGSM OAuth message
 * @param authUrl Authentication URL
 * @param apiConfiguration API configuration
 * @param provider ClineProvider instance
 */
export async function handleZgsmLogin(
	authUrl: string,
	apiConfiguration: ApiConfiguration,
	provider: ClineProvider,
): Promise<void> {
	// Open authentication link
	await vscode.env.openExternal(vscode.Uri.parse(authUrl))

	// Save apiConfiguration for use after successful authentication
	if (apiConfiguration) {
		await provider.updateApiConfiguration(apiConfiguration)
	}

	// Send message to webview to notify that authentication has started
	provider.postMessageToWebview({ type: "state", state: await provider.getStateToPostToWebview() })
}

/**
 * Get access token
 * @param code Authorization code
 * @param apiConfiguration API configuration
 * @returns Response containing access token
 */
export async function getAccessToken(code: string, apiConfiguration?: ApiConfiguration) {
	try {
		// Prefer configuration in apiConfiguration, if not exist, use environment settings
		const clientId = apiConfiguration?.zgsmClientId || "vscode"
		const clientSecret = apiConfiguration?.zgsmClientSecret || "jFWyVy9wUKKSkX55TDBt2SuQWl7fDM1l"
		const redirectUri = apiConfiguration?.zgsmRedirectUri || `${apiConfiguration?.zgsmBaseUrl}/login/ok`
		const tokenUrl =
			apiConfiguration?.zgsmTokenUrl ||
			(apiConfiguration?.zgsmBaseUrl
				? `${apiConfiguration.zgsmBaseUrl}/realms/gw/protocol/openid-connect/token`
				: "https://zgsm.sangfor.com/realms/gw/protocol/openid-connect/token")

		// Set request parameters
		const params = {
			client_id: clientId,
			client_secret: clientSecret,
			code: code,
			grant_type: "authorization_code",
			redirect_uri: redirectUri,
		}

		// Use querystring to convert object to application/x-www-form-urlencoded format
		const formData = querystring.stringify(params)

		// Use fetch to send request and get token, add created request headers
		const res = await fetch(tokenUrl, {
			method: "POST",
			headers: createHeaders({
				"Content-Type": "application/x-www-form-urlencoded",
			}),
			body: formData,
		})

		const data = await res.json()

		// Successfully obtained token
		if (res.status === 200 && data && data.access_token) {
			return {
				status: 200,
				data,
			}
		} else {
			return {
				status: res.status || 400,
				data: null,
			}
		}
	} catch (err) {
		console.error("fetchToken: Axios error:", err.message)
		throw err
	}
}
