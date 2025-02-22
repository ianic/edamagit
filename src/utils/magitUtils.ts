import * as vscode from 'vscode';
import { MagitRepository } from '../models/magitRepository';
import { magitRepositories, views, gitApi } from '../extension';
import { window, Uri, commands } from 'vscode';
import * as Status from '../commands/statusCommands';
import { DocumentView } from '../views/general/documentView';
import FilePathUtils from './filePathUtils';
import { RefType, Repository } from '../typings/git';
import { PickMenuItem, PickMenuUtil } from '../menu/pickMenu';
import GitTextUtils from '../utils/gitTextUtils';
import * as Constants from '../common/constants';

export interface Selection {
  key: string;
  description: string;
}

export default class MagitUtils {

  public static getMagitRepoThatContainsFile(uri: Uri): MagitRepository | undefined {

    let discoveredRepos = Array.from(magitRepositories.entries());

    let discoveredReposContainingFile = discoveredRepos
      .filter(([path, repo]) => FilePathUtils.isDescendant(path, uri.fsPath));

    // TODO: refactor
    if (discoveredRepos.length < gitApi.repositories.length) {
      let gitExtensionReposContainingFile = gitApi.repositories
        .filter((repo) => FilePathUtils.isDescendant(repo.rootUri.fsPath, uri.fsPath));

      // If repos in total containing file outnumbers discovered repos containing file, return undefined
      if (gitExtensionReposContainingFile.length > discoveredReposContainingFile.length) {
        return undefined;
      }
    }

    if (discoveredReposContainingFile.length === 1) {
      return discoveredReposContainingFile[0][1];
    } else if (discoveredReposContainingFile.length > 0) {
      return discoveredReposContainingFile.sort(([pathA, repoA], [pathB, repoB]) => pathB.length - pathA.length)[0][1];
    }
  }

  public static async getCurrentMagitRepo(uri?: Uri): Promise<MagitRepository | undefined> {

    let magitRepository = this.getCurrentMagitRepoNO_STATUS(uri);

    // TODO: Should maybe call 'internalMagitStatus' here to guarantee updated MagitRepository, but it slows down everything :p
    // if (magitRepository) {
    //   magitRepository = await Status.internalMagitStatus(magitRepository.gitRepository);
    //   magitRepositories.set(magitRepository.uri.fsPath, magitRepository);
    // }
    if (!magitRepository) {
      let repository = await this.discoverRepo(uri);
      if (repository) {
        magitRepository = await Status.internalMagitStatus(repository);
        magitRepositories.set(magitRepository.uri.fsPath, magitRepository);
      }
    }

    return magitRepository;
  }

  public static getCurrentMagitRepoNO_STATUS(uri?: Uri): MagitRepository | undefined {
    let magitRepository: MagitRepository | undefined;

    if (uri) {
      magitRepository = magitRepositories.get(uri.query);
      if (!magitRepository) {
        magitRepository = this.getMagitRepoThatContainsFile(uri);
      }
    }

    return magitRepository;
  }

  private static discoverRepoThatContainsFile(uri: Uri): Repository | undefined {
    let reposContainingFile = gitApi.repositories.filter(r => FilePathUtils.isDescendant(r.rootUri.fsPath, uri.fsPath));

    if (reposContainingFile.length === 1) {
      return reposContainingFile[0];
    }

    if (reposContainingFile.length > 0) {
      return reposContainingFile.sort((repoA, repoB) => repoB.rootUri.fsPath.length - repoA.rootUri.fsPath.length)[0];
    }
  }

  public static async discoverRepo(uri?: Uri): Promise<Repository | undefined> {

    let repository;

    if (gitApi.repositories.length === 1) {
      repository = gitApi.repositories[0];
    }
    else if (gitApi.repositories.length) {

      if (uri) {
        repository = this.discoverRepoThatContainsFile(uri);
      }

      if (!repository && vscode.workspace.workspaceFolders?.length === 1) {
        repository = this.discoverRepoThatContainsFile(vscode.workspace.workspaceFolders[0].uri);
      }

      if (!repository) {
        type RepoPickResult = { repository?: Repository, initRepo?: Boolean };

        const repoPicker: PickMenuItem<RepoPickResult | undefined>[] = gitApi.repositories.map(repo => ({ label: repo.rootUri.fsPath, meta: { repository: repo } }));

        repoPicker.push({ label: 'Init repo', meta: { initRepo: true } });
        let result = await PickMenuUtil.showMenu(repoPicker, 'Which repository?');

        if (result?.initRepo) {
          commands.executeCommand('git.init');
          return undefined;
        } else if (result?.repository) {
          repository = result.repository;
        } else {
          return undefined;
        }
      }
    }

    if (!repository) {
      await commands.executeCommand('git.init');
    }

    return repository;
  }

  public static getCurrentMagitRepoAndView(uri: Uri): [MagitRepository | undefined, DocumentView | undefined] {
    const repository = magitRepositories.get(uri.query);
    const currentView = views.get(uri.toString());
    return [repository, currentView];
  }

  public static async magitStatusAndUpdate(repository: MagitRepository) {
    let updatedRepository = await Status.internalMagitStatus(repository.gitRepository);
    magitRepositories.set(updatedRepository.uri.fsPath, updatedRepository);
    views.forEach(view => view.needsUpdate && view.uri.query === updatedRepository.uri.fsPath ? view.update(updatedRepository) : undefined);
  }

  public static magitAnythingModified(repository: MagitRepository): boolean {
    return (repository.indexChanges.length > 0 ||
      repository.workingTreeChanges.length > 0 ||
      (repository.mergeChanges?.length ?? 0) > 0);
  }

  public static async chooseRef(repository: MagitRepository, prompt: string, showCurrent = false, showHEAD = false, allowFreeform = true, remoteOnly = false): Promise<string> {

    const refs: PickMenuItem<string>[] = [];

    if (showCurrent && repository.HEAD?.name) {
      refs.push({
        label: repository.HEAD.name,
        description: GitTextUtils.shortHash(repository.HEAD.commit),
        meta: repository.HEAD.name
      });
    }

    if (showHEAD) {
      refs.push({
        label: 'HEAD',
        description: GitTextUtils.shortHash(repository.HEAD?.commit),
        meta: 'HEAD'
      });
    }

    refs.push(...repository.refs
      .filter(ref => ref.name !== repository.HEAD?.name && (!remoteOnly || ref.type === RefType.RemoteHead))
      .sort((refA, refB) => refA.type - refB.type).map(r => ({
        label: r.name!,
        description: GitTextUtils.shortHash(r.commit),
        meta: r.name!
      })));

    if (allowFreeform) {
      return PickMenuUtil.showMenuWithFreeform(refs, prompt);
    } else {
      return PickMenuUtil.showMenu(refs, prompt);
    }
  }

  public static async chooseCommit(repository: MagitRepository, prompt: string): Promise<string> {

    const commitPicker = repository.log.map(commit => ({
      label: GitTextUtils.shortHash(commit.hash),
      description: commit.message,
      meta: commit.hash
    })) ?? [];

    return PickMenuUtil.showMenuWithFreeform(commitPicker, prompt);
  }

  public static async chooseTag(repository: MagitRepository, prompt: string) {
    const refs = repository.refs
      .filter(ref => ref.type === RefType.Tag)
      .map(r => r.name!);

    return window.showQuickPick(refs, { placeHolder: prompt });
  }

  public static async confirmAction(prompt: string) {

    let renderedPrompt = `${prompt} (y or n)`;

    return new Promise(resolve => {

      let resolveOnHide = true;

      const _inputBox = window.createInputBox();
      _inputBox.validationMessage = renderedPrompt;

      let changeListener = _inputBox.onDidChangeValue(e => {
        if (e.toLowerCase().includes('y')) {
          resolveOnHide = false;
          _inputBox.hide();
          resolve(true);
        } else if (e.toLowerCase().includes('n') || e.toLowerCase().includes('q')) {
          _inputBox.hide();
        }
      });

      let onHideListener = _inputBox.onDidHide(() => {
        _inputBox.dispose();
        changeListener.dispose();
        onHideListener.dispose();
        if (resolveOnHide) {
          window.setStatusBarMessage('Abort', Constants.StatusMessageDisplayTimeout);
          resolve(false);
        }
      });

      _inputBox.show();
    });
  }

  public static async selectAction(prompt: string, options: Selection[]): Promise<string | undefined> {

    const optionsStr = options.reduce((acc, current) => {
      const { description } = current;
      if (acc !== '') {
        return acc.concat(', ', description);
      } else {
        return acc.concat(description);
      }
    }, '');
    let renderedPrompt = `${prompt}: Select one of ${optionsStr} or [q] to abort`;

    return new Promise(resolve => {

      let resolveOnHide = true;
      let selection = options[0].key;

      const _inputBox = window.createInputBox();
      _inputBox.validationMessage = renderedPrompt;

      let changeListener = _inputBox.onDidChangeValue(e => {
        const input = e.toLocaleLowerCase();
        let found = options.find((selection) => selection.key === input);
        if (found) {
          resolveOnHide = false;
          _inputBox.hide();
          resolve(found.key);
        } else if (e.toLowerCase().includes('q')) {
          _inputBox.hide();
        }
      });

      let onHideListener = _inputBox.onDidHide(() => {
        _inputBox.dispose();
        changeListener.dispose();
        onHideListener.dispose();
        if (resolveOnHide) {
          window.setStatusBarMessage('Abort', Constants.StatusMessageDisplayTimeout);
          resolve(undefined);
        }
      });

      _inputBox.show();
    });
  }
}

