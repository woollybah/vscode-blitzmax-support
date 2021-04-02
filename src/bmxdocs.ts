'use strict'

import * as fs from 'fs'
import { EOL } from 'os'
import * as vscode from 'vscode'
import * as cp from 'child_process'
import { BlitzMaxPath } from './helper'
import { getCurrentDocumentWord } from './common'
import * as awaitNotify from 'await-notify'

let _commandsList: BmxCommand[]

export function registerDocsProvider( context: vscode.ExtensionContext ) {
	// Related commands
	context.subscriptions.push( vscode.commands.registerCommand( 'blitzmax.quickHelp', ( word: any ) => {
		// If no word was specified, we look at the word under the cursor
		if ( !word || typeof word !== "string" ) word = getCurrentDocumentWord()
		showQuickHelp( word )
	} ) )

	context.subscriptions.push( vscode.commands.registerCommand( 'blitzmax.rebuildDoc', _ => {
		if ( !BlitzMaxPath ) return

		vscode.window.withProgress( {
			location: vscode.ProgressLocation.Notification,
			title: 'Rebuilding Documentation',
			cancellable: true
		}, async ( progress, token ) => {
			if ( !BlitzMaxPath ) return

			let busy = new awaitNotify.Subject()

			token.onCancellationRequested( () => {
				if ( docProcess ) {
					docProcess.kill( 'SIGINT' )
					docProcess.kill( 'SIGKILL' )
					busy.notify()
				}
			} )

			const procStart = process.hrtime()
			let docProcess = cp.spawn( BlitzMaxPath + '/bin/makedocs' )

			function reportProgress( data: any ) {
				const str: string[] = data.toString().split( EOL )
				for ( let index = 0; index < str.length; index++ ) {
					const line = str[index].trim()
					if ( line.length > 1 ) progress.report( { message: line } )
				}
			}

			docProcess.stdout.on( 'data', ( data ) => {
				reportProgress( data )
			} )

			docProcess.stderr.on( 'data', ( data ) => {
				reportProgress( data )
			} )

			docProcess.on( 'error', ( error ) => {
				console.error( error.message )
				vscode.window.showErrorMessage( 'Error rebuilding documentation: ' + error.message )
			} )

			docProcess.on( 'close', ( code ) => {
				const procEnd = process.hrtime( procStart )

				console.log( `Rebuild documentation time: ${procEnd[0]}s ${procEnd[1] / 1000000}ms\r\n\r\n` )
				busy.notify()
			} )

			await busy.wait()
			return
		} )
	} ) )
}

export async function showQuickHelp( command: string ) {
	cacheCommandsIfEmpty( true )
	if ( !_commandsList ) return
	let commands = getCommand( command, { hasDescription: true } )

	// Multi match
	if ( commands.length > 1 ) {
		let pickOptions: vscode.QuickPickItem[] = []
		commands.forEach( match => {
			pickOptions.push( { label: match.realName, detail: match.module } )
		} )

		vscode.window.showQuickPick( pickOptions ).then( selection => {
			for ( let index = 0; index < pickOptions.length; index++ ) {
				const pickItem = pickOptions[index];
				if ( pickItem === selection ) {
					generateQuickHelp( commands[index] )
					return
				}
			}
		} )
		return
	}

	// Single match
	if ( commands.length == 1 ) {
		generateQuickHelp( commands[0] )
		return
	}

	// No match
	vscode.window.showErrorMessage( 'No help available for "' + command + '"' )
	return
}

function generateQuickHelp( command: BmxCommand ) {
	if ( !command ) return

	if ( command.description ) {
		// TODO make a big fancy page showing for description display
		vscode.window.showInformationMessage( command.description )
	} else {
		vscode.window.showErrorMessage( ' "' + command.realName + '" has no help section' )
	}
}

// Fetch all commands matching a string
interface GetCommandFilter {
	hasDescription?: boolean
	hasMarkdown?: boolean
	hasParameters?: boolean
}
export function getCommand( command: string | undefined = undefined, filter: GetCommandFilter | undefined = undefined ): BmxCommand[] {
	// Cache commands if needed
	cacheCommandsIfEmpty( false )
	if ( !_commandsList ) return []

	// Find the command
	if ( command ) command = command.toLowerCase()
	let matches: BmxCommand[] = []

	for ( let index = 0; index < _commandsList.length; index++ ) {
		const cmd = _commandsList[index]
		if ( !command || ( command && cmd.searchName == command ) ) {

			// Filter out some matches
			if ( filter ) {
				if ( filter.hasDescription && !cmd.description ) continue
				if ( filter.hasMarkdown && !cmd.markdownString ) continue
				if ( filter.hasParameters && ( !cmd.params || cmd.params.length <= 0 ) ) continue
			}

			matches.push( cmd )
		}
	}

	return matches
}

export function cacheCommandsIfEmpty( showPopup: boolean ): boolean {
	if ( !_commandsList || _commandsList.length <= 0 ) cacheCommands( showPopup )
	return _commandsList ? _commandsList.length >= 0 : false
}

// Read commands.txt and then add the command (addCommand)
function cacheCommands( showPopup: boolean ): boolean {
	console.log( 'Caching BlitzMax commands' )

	const globalBmxPath = vscode.workspace.getConfiguration( 'blitzmax' ).inspect( 'base.path' )?.globalValue
	const relativePath = '/docs/html/Modules/commands.txt'
	const absolutePath = vscode.Uri.file( globalBmxPath + relativePath ).fsPath

	try {
		const data = fs.readFileSync( absolutePath, 'utf8' )
		_commandsList = []
		addCommand( data )
	} catch ( err ) {
		//console.error( 'Couldn\'t open commands.txt:' )
		//console.error( err )
	}

	// Did we add any commands?
	if ( BlitzMaxPath && showPopup ) {
		if ( !_commandsList || _commandsList.length <= 0 ) {
			// Notify about building docs
			vscode.window.showWarningMessage( 'Documentation not found.\nWould you like to rebuild documentation now?',
				'No', 'Yes' ).then( ( selection ) => {
					if ( selection && selection.toLowerCase() == 'yes' )
						vscode.commands.executeCommand( 'blitzmax.rebuildDoc' )
				} )
		}
	}

	return _commandsList ? _commandsList.length >= 0 : false
}

// Process a line/lines from commands.txt
function addCommand( data: string ) {
	const lines = data.split( EOL )
	lines.forEach( line => {
		if ( line ) {

			const lineSplit = line.split( '|' )
			const command: BmxCommand = {
				realName: 'No Name', searchName: 'no name', isFunction: false, returns: undefined
			}
			let leftSide = lineSplit[0]
			let rightSide = lineSplit[lineSplit.length - 1]

			// Figure out URL
			if ( rightSide.includes( '#' ) ) {
				command.urlLocation = rightSide.substr( rightSide.indexOf( '#' ) )
				command.url = rightSide.slice( 0, -command.urlLocation.length )
			} else {
				command.url = rightSide
			}

			// Track down module
			if ( command.url ) {
				const pathSplits = command.url.split( '/' )

				if ( pathSplits[1].toLowerCase() == 'docs' ) {
					command.module = pathSplits[4] + '/' + pathSplits[5]
				} else if ( pathSplits[1].toLowerCase() == 'mod' ) {
					command.module = pathSplits[2] + '/' + pathSplits[3]
				}
			}

			// Take care of the description
			if ( leftSide.includes( ' : ' ) ) {
				command.description = leftSide.split( ' : ' )[1]
				leftSide = leftSide.slice( 0, -command.description.length - 3 )
			}

			// Figure out if this is a function
			if ( leftSide.includes( '(' ) ) {
				command.paramsRaw = leftSide.substr( leftSide.indexOf( '(' ) + 1 ).slice( 0, -1 )
				leftSide = leftSide.slice( 0, -command.paramsRaw.length - 2 )
				parseCommandParams( command )
				command.isFunction = true
			}

			// Returns?
			if ( leftSide.includes( ':' ) ) {
				command.returns = leftSide.substr( leftSide.indexOf( ':' ) + 1 )
				leftSide = leftSide.slice( 0, -command.returns.length - 1 )
			}

			// And we should be left with the command name
			command.realName = leftSide
			command.searchName = command.realName.toLowerCase()

			// Make a pretty markdown description of this command
			if ( command.description || command.paramsPretty ) {
				command.shortMarkdownString = new vscode.MarkdownString( undefined, true )
				command.markdownString = new vscode.MarkdownString( undefined, true )

				if ( command.paramsPretty ) {
					let codeBlock = command.realName

					// Construct code block
					if ( command.returns ) codeBlock += ':' + command.returns
					codeBlock += '( ' + command.paramsPretty + ' )'

					// Append
					command.markdownString.appendCodeblock( codeBlock, 'blitzmax'
					)
				}

				if ( command.description ) {
					command.markdownString.appendText( command.description + '\n' )
					command.shortMarkdownString.appendText( command.description + '\n' )
				}

				if ( command.module ) {
					command.markdownString.appendMarkdown( '$(package) _' + command.module + '_\n' )
					command.shortMarkdownString.appendMarkdown( '$(package) _' + command.module + '_\n' )
				}

			}

			// Make pretty insertion text
			if ( command.isFunction ) {
				command.insertText = new vscode.SnippetString( command.realName )
				command.insertText.appendText( '(' )
				if ( command.params ) {
					command.insertText.appendText( ' ' )
					for ( let index = 0; index < command.params.length; index++ ) {
						const param = command.params[index]

						if ( param.default ) {
							command.insertText.appendPlaceholder( param.default )
						} else {
							command.insertText.appendPlaceholder( param.name + ':' + param.type )
						}
						if ( index < command.params.length - 1 ) command.insertText.appendText( ', ' )
					}
					command.insertText.appendText( ' ' )
				}
				command.insertText.appendText( ')' )
			}

			// Done!
			_commandsList.push( command )
		}

	} )
}

function parseCommandParams( cmd: BmxCommand ) {

	// Make sure there's actually something to parse
	if ( !cmd.paramsRaw ) return
	cmd.paramsRaw = cmd.paramsRaw.trim()
	if ( !cmd.paramsRaw ) return

	// Reset//create the parameter array
	cmd.params = []

	// Make sure we have at least one parameter to work with
	let createNewParam: boolean = true

	// Current step of parsing
	enum parsePart {
		name,
		type,
		default
	}
	let parse: parsePart = parsePart.name

	// Currently parsing inside a string?
	let inString: boolean = false

	// Go through parameters, letter by letter
	for ( let index = 0; index < cmd.paramsRaw.length; index++ ) {
		const chr = cmd.paramsRaw[index]

		if ( createNewParam ) {
			createNewParam = false
			cmd.params.push( { name: '', type: 'Int', default: '' } )
		}

		const param = cmd.params[cmd.params.length - 1]

		switch ( parse ) {
			case parsePart.name:
				// Add character to the parameters name
				switch ( chr ) {

					// Move onto type parsing
					case ':':
						param.type = ''
						parse = parsePart.type
						break

					// Assume Int type and move to default value
					case '=':
						parse = parsePart.default
						break

					// Assume Int type and move to new value
					case ',':
						// Reset
						createNewParam = true
						parse = parsePart.name
						break

					// Ugh I hate these old BASIC type shortcuts!
					case '%':
						param.type = 'Int'
						parse = parsePart.type
						break

					case '#':
						param.type = 'Float'
						parse = parsePart.type
						break

					case '!':
						param.type = 'Double'
						parse = parsePart.type
						break

					case '$':
						param.type = 'String'
						parse = parsePart.type
						break

					// Okay NOW add to the name
					default:
						if ( chr != ' ' ) param.name += chr
						break
				}
				break

			case parsePart.type:
				// The type of this parameter
				switch ( chr ) {
					case ',':
						// Reset
						createNewParam = true
						parse = parsePart.name
						break

					case '=':
						parse = parsePart.default
						break

					default:
						if ( chr != ' ' ) param.type += chr
						break
				}
				break

			case parsePart.default:
				// The default value of this parameter

				if ( inString ) {
					param.default += chr
				} else {
					if ( chr == ',' ) {
						// Reset
						createNewParam = true
						parse = parsePart.name

					} else {
						if ( chr != ' ' ) param.default += chr
					}
				}

				if ( chr == '"' ) inString = !inString
				break
		}
	}

	// Make things pretty!
	cmd.paramsPretty = ''

	for ( let index = 0; index < cmd.params.length; index++ ) {
		const param = cmd.params[index]

		cmd.paramsPretty += param.name + ':' + param.type
		if ( param.default.length > 0 ) cmd.paramsPretty += ' = ' + param.default

		if ( index < cmd.params.length - 1 ) cmd.paramsPretty += ', '
	}
}

interface BmxCommand {
	realName: string,
	searchName: string
	description?: string,
	shortMarkdownString?: vscode.MarkdownString
	markdownString?: vscode.MarkdownString

	isFunction: boolean
	returns?: string,
	params?: BmxCommandParam[],
	paramsRaw?: string,
	paramsPretty?: string

	url?: string,
	urlLocation?: string

	module?: string

	insertText?: vscode.SnippetString
}

interface BmxCommandParam {
	name: string,
	type: string,
	default: string
}