/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken, InlineCompletionContext } from 'vscode';

import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { DocumentId } from '../../../platform/inlineEdits/common/dataTypes/documentId';
import { InlineEditRequestLogContext } from '../../../platform/inlineEdits/common/inlineEditLogContext';
import { ObservableWorkspace } from '../../../platform/inlineEdits/common/observableWorkspace';
import { ShowNextEditPreference } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { Completion } from '../../../platform/nesFetch/common/completionsAPI';
import { ICompletionsFetchService } from '../../../platform/nesFetch/common/completionsFetchService';
import { createTracer, ITracer } from '../../../util/common/tracing';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { StringReplacement } from '../../../util/vs/editor/common/core/edits/stringEdit';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../util/vs/editor/common/core/text/abstractText';
import { NextEditFetchRequest } from '../../inlineEdits/node/nextEditProvider';
import { NextEditResult } from '../../inlineEdits/node/nextEditResult';
import { toUniquePath } from '../../xtab/common/promptCrafting';
import { BlockMode, shouldDoServerTrimming } from '../common/config';
import { contextIndentation } from '../common/parseBlock';

export class CompletionsProvider extends Disposable {

	private tracer: ITracer;

	constructor(
		private workspace: ObservableWorkspace,
		// @ICAPIClientService private apiClient: ICAPIClientService,
		@ICompletionsFetchService private fetchService: ICompletionsFetchService,
		@IConfigurationService private configService: IConfigurationService,
		// @IExperimentationService private expService: IExperimentationService,
		@ILogService private logService: ILogService,
	) {
		super();
		this.tracer = createTracer(['NES', 'Completions'], (msg) => this.logService.trace(msg));
	}

	public async getCompletions(
		documentId: DocumentId,
		context: InlineCompletionContext,
		logContext: InlineEditRequestLogContext,
		token: CancellationToken
	): Promise<NextEditResult | undefined> {
		const startTime = Date.now();

		const doc = this.workspace.getDocument(documentId);
		if (!doc) {
			throw new Error(`Document with ID ${documentId} not found.`);
		}

		const docContents = doc.value.get();
		const docSelection = doc.selection.get();
		const languageId = doc.languageId.get();

		// TODO@ulugbekna: handle multi-selection cases
		if (docSelection.length !== 1 || !docSelection[0].isEmpty) {
			return;
		}

		const selection = docSelection[0];

		const isMidword = this.isAtMidword(docContents, selection.start);
		if (isMidword) {
			this.tracer.returns('Midword completion not supported');
			return;
		}

		const prefix = docContents.getValue().substring(0, selection.start);
		const suffix = docContents.getValue().substring(selection.start); // we use `.start` again because the selection is empty

		const workspaceRoot = this.workspace.getWorkspaceRoot(documentId);
		const filepath = toUniquePath(documentId, workspaceRoot?.path);

		const blockMode = BlockMode.ParsingAndServer;

		// 直接使用配置的API信息，不再需要GitHub鉴权
		const url = this.configService.getConfig(ConfigKey.Internal.CompletionsProviderAnonymousApiUrl);
		const secretKey = this.configService.getConfig(ConfigKey.Internal.CompletionsProviderAnonymousApiKey);
		const modelName = this.configService.getConfig(ConfigKey.Internal.CompletionsProviderAnonymousModelName);

		if (!url || !secretKey) {
			this.tracer.throws('API配置未设置');
			throw new Error('请在设置中配置API地址和密钥');
		}
		console.log(`普通补全，当前的模型为${modelName}`);
		const r = await this.fetchService.fetch(
			url,
			secretKey,
			{
				model: modelName,
				prompt: prefix,
				suffix: suffix,
				max_tokens: 500, // TODO@ulugbekna
				temperature: 0,
				top_p: 1,
				n: 1,
				stop: [
					"\n" // TODO@ulugbekna
				],
				stream: true,
				extra: {
					language: languageId,
					next_indent: contextIndentation(docContents, selection.start, languageId).next ?? 0,
					trim_by_indentation: shouldDoServerTrimming(blockMode),
					prompt_tokens: Math.ceil(prefix.length / 4), // TODO@ulugbekna
					suffix_tokens: Math.ceil(suffix.length / 4),
					context: [
						`Path: ${filepath}`
					]
				},
				// nwo // TODO@ulugbekna
				code_annotations: false, // TODO@ulugbekna
			},
			generateUuid(),
			token,
		);

		if (r.isError()) {
			console.log(`普通补全，报错信息${r}`);
			return;
		}

		const maybeCompletion = await r.val.response;

		if (maybeCompletion.isError() || maybeCompletion.val.choices.length === 0) {
			return;
		}

		const choice = maybeCompletion.val.choices[0];

		if (choice.finish_reason !== Completion.FinishReason.Stop || !choice.text) {
			return;
		}

		return new NextEditResult(logContext.requestId, new NextEditFetchRequest(context.requestUuid, logContext, startTime), {
			edit: new StringReplacement(new OffsetRange(selection.start, selection.endExclusive), choice.text),
			documentBeforeEdits: docContents,
			showRangePreference: ShowNextEditPreference.Always,
		});
	}

	private isAtMidword(document: StringText, offset: number): boolean {
		const isAtLastChar = offset + 1 >= document.value.length;
		if (isAtLastChar) {
			return false;
		}
		return document.value[offset + 1].match(/\w/) !== null;
	}

}
