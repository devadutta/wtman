import readline from 'node:readline/promises';
import React, { useEffect, useRef, useState } from 'react';
import { Box, Spacer, Text, render, useAnimation, useApp, useInput, useWindowSize } from 'ink';
import { SelectionCancelledError } from './errors.js';

const COLORS = {
  accent: 'cyan',
  danger: 'red',
  muted: 'gray',
  success: 'green',
  warning: 'yellow'
};

function promptOutput(runtime) {
  return runtime.stderr || runtime.stdout;
}

function canUseInteractivePrompt(runtime) {
  return Boolean(
    runtime.stdin?.isTTY
    && promptOutput(runtime)?.isTTY
    && typeof runtime.stdin.setRawMode === 'function'
  );
}

function isSameChoiceValue(left, right) {
  if (left === right) {
    return true;
  }

  return Boolean(left?.path && right?.path && left.path === right.path);
}

function cancellation() {
  return new SelectionCancelledError();
}

function isControlC(input, key) {
  return key.ctrl && (input === 'c' || input === '\u0003');
}

function isKeyRelease(key) {
  return key.eventType === 'release';
}

function Question({ children }) {
  return (
    <Text>
      <Text color={COLORS.accent} bold>◆</Text>
      {' '}
      <Text bold>{children}</Text>
    </Text>
  );
}

function KeyHint({ keys, children }) {
  return (
    <Text>
      <Text color={COLORS.accent} bold>{keys}</Text>
      <Text dimColor> {children}</Text>
    </Text>
  );
}

function MenuFrame({ label, header, choices, selectedIndex, refreshing, worktreeMenu = false }) {
  const { columns } = useWindowSize();
  const compact = columns < 72 && choices.some((choice) => choice.compactLabel);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={COLORS.accent} bold>wtman</Text>
        <Text dimColor> / {label.replace(/:$/, '')}</Text>
        <Spacer />
        {refreshing
          ? <Text color={COLORS.warning}>syncing PRs…</Text>
          : <Text dimColor>{choices.length} worktree{choices.length === 1 ? '' : 's'}</Text>}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {header ? (
          <Box>
            <Text>{'  '}</Text>
            <Text dimColor wrap="truncate-end">
              {compact ? 'Folder · Branch · Changes · Pull request' : header}
            </Text>
          </Box>
        ) : null}
        {choices.map((choice, index) => {
          const selected = index === selectedIndex;

          return (
            <Box key={choice.value?.path || String(choice.value)}>
              <Text color={selected ? COLORS.accent : undefined} bold>{selected ? '▌' : ' '}</Text>
              <Text>{' '}</Text>
              <Text inverse={selected} bold={selected} wrap="truncate-end">
                {compact ? choice.compactLabel || choice.label : choice.label}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} columnGap={2} flexWrap="wrap">
        <KeyHint keys="↑↓ / jk">move</KeyHint>
        <KeyHint keys="enter">{worktreeMenu ? 'switch' : 'select'}</KeyHint>
        {worktreeMenu ? (
          <>
            <KeyHint keys="f">refresh</KeyHint>
            <KeyHint keys="n">new</KeyHint>
            <KeyHint keys="r">remove</KeyHint>
            <KeyHint keys="c">config</KeyHint>
            <KeyHint keys="q / esc">quit</KeyHint>
          </>
        ) : (
          <KeyHint keys="esc">cancel</KeyHint>
        )}
      </Box>
    </Box>
  );
}

function useMenuState(initialChoices, initialHeader, updatePromise, mapUpdate) {
  const initialMenu = {
    choices: initialChoices,
    header: initialHeader,
    selectedIndex: 0,
    refreshing: Boolean(updatePromise)
  };
  const menuRef = useRef(initialMenu);
  const [menu, setMenu] = useState(initialMenu);

  function updateMenu(updater) {
    const nextMenu = typeof updater === 'function' ? updater(menuRef.current) : updater;
    menuRef.current = nextMenu;
    setMenu(nextMenu);
  }

  useEffect(() => {
    if (!updatePromise) {
      return undefined;
    }

    let active = true;

    void Promise.resolve(updatePromise)
      .then(async (value) => {
        if (!active) {
          return null;
        }

        return typeof mapUpdate === 'function' ? mapUpdate(value) : value;
      })
      .then((update) => {
        if (!active || !update) {
          return;
        }

        updateMenu((previous) => {
          const selectedValue = previous.choices[previous.selectedIndex]?.value;
          const choices = update.choices?.length > 0 ? update.choices : previous.choices;
          const updatedIndex = choices.findIndex((choice) => isSameChoiceValue(choice.value, selectedValue));

          return {
            choices,
            header: update.header ?? previous.header,
            selectedIndex: updatedIndex >= 0
              ? updatedIndex
              : Math.min(previous.selectedIndex, choices.length - 1),
            refreshing: false
          };
        });
      })
      .catch(() => {
        if (active) {
          updateMenu((previous) => ({ ...previous, refreshing: false }));
        }
      });

    return () => {
      active = false;
    };
  }, [mapUpdate, updatePromise]);

  function moveSelection(amount) {
    updateMenu((previous) => {
      const count = previous.choices.length;
      const selectedIndex = (previous.selectedIndex + amount + count) % count;
      return { ...previous, selectedIndex };
    });
  }

  function selectBoundary(position) {
    updateMenu((previous) => ({
      ...previous,
      selectedIndex: position === 'start' ? 0 : previous.choices.length - 1
    }));
  }

  function selectedValue() {
    return menuRef.current.choices[menuRef.current.selectedIndex]?.value;
  }

  return { menu, moveSelection, selectBoundary, selectedValue };
}

function SelectPrompt({ label, choices, header }) {
  const { exit } = useApp();
  const { menu, moveSelection, selectBoundary, selectedValue } = useMenuState(choices, header);

  useInput((input, key) => {
    if (isKeyRelease(key)) {
      return;
    }

    if (isControlC(input, key) || key.escape) {
      exit(cancellation());
      return;
    }

    if (key.upArrow || input === 'k') {
      moveSelection(-1);
      return;
    }

    if (key.downArrow || input === 'j') {
      moveSelection(1);
      return;
    }

    if (key.pageUp) {
      moveSelection(-5);
      return;
    }

    if (key.pageDown) {
      moveSelection(5);
      return;
    }

    if (key.home) {
      selectBoundary('start');
      return;
    }

    if (key.end) {
      selectBoundary('end');
      return;
    }

    if (key.return) {
      exit(selectedValue());
    }
  });

  return (
    <MenuFrame
      label={label}
      header={menu.header}
      choices={menu.choices}
      selectedIndex={menu.selectedIndex}
    />
  );
}

function WorktreeMenuPrompt({ label, choices, header, updatePromise, mapUpdate }) {
  const { exit } = useApp();
  const { menu, moveSelection, selectBoundary, selectedValue } = useMenuState(choices, header, updatePromise, mapUpdate);

  useInput((input, key) => {
    if (isKeyRelease(key)) {
      return;
    }

    if (isControlC(input, key)) {
      exit(cancellation());
      return;
    }

    if (key.escape || input.toLowerCase() === 'q') {
      exit({ action: 'quit' });
      return;
    }

    if (key.upArrow || input === 'k') {
      moveSelection(-1);
      return;
    }

    if (key.downArrow || input === 'j') {
      moveSelection(1);
      return;
    }

    if (key.pageUp) {
      moveSelection(-5);
      return;
    }

    if (key.pageDown) {
      moveSelection(5);
      return;
    }

    if (key.home) {
      selectBoundary('start');
      return;
    }

    if (key.end) {
      selectBoundary('end');
      return;
    }

    const selected = selectedValue();

    if (key.return) {
      exit({ action: 'switch', value: selected });
      return;
    }

    const shortcut = input.toLowerCase();

    if (shortcut === 'f') {
      exit({ action: 'refresh' });
    } else if (shortcut === 'n') {
      exit({ action: 'new' });
    } else if (shortcut === 'r') {
      exit({ action: 'remove', value: selected });
    } else if (shortcut === 'c') {
      exit({ action: 'config' });
    }
  });

  return (
    <MenuFrame
      label={label}
      header={menu.header}
      choices={menu.choices}
      selectedIndex={menu.selectedIndex}
      refreshing={menu.refreshing}
      worktreeMenu
    />
  );
}

function ConfirmPrompt({ label, defaultValue }) {
  const { exit } = useApp();
  const selectedRef = useRef(defaultValue);
  const [selected, setSelected] = useState(defaultValue);

  function toggleSelection() {
    selectedRef.current = !selectedRef.current;
    setSelected(selectedRef.current);
  }

  useInput((input, key) => {
    if (isKeyRelease(key)) {
      return;
    }

    if (isControlC(input, key) || key.escape) {
      exit(cancellation());
      return;
    }

    if (key.leftArrow || key.rightArrow || key.tab) {
      toggleSelection();
      return;
    }

    if (input.toLowerCase() === 'y') {
      exit(true);
      return;
    }

    if (input.toLowerCase() === 'n') {
      exit(false);
      return;
    }

    if (key.return) {
      exit(selectedRef.current);
    }
  });

  return (
    <Box flexDirection="column">
      <Question>{label}</Question>
      <Box marginLeft={2} marginTop={1} columnGap={1}>
        <Text
          backgroundColor={selected ? COLORS.accent : undefined}
          color={selected ? 'black' : COLORS.muted}
          bold={selected}
        >
          {' Yes '}
        </Text>
        <Text
          backgroundColor={!selected ? COLORS.accent : undefined}
          color={!selected ? 'black' : COLORS.muted}
          bold={!selected}
        >
          {' No '}
        </Text>
        <Text dimColor>y/n · enter confirm · esc cancel</Text>
      </Box>
    </Box>
  );
}

function removeBeforeCursor(characters, cursor, mode = 'character') {
  if (cursor === 0) {
    return { characters, cursor };
  }

  let start = cursor - 1;

  if (mode === 'word') {
    while (start > 0 && /\s/.test(characters[start])) {
      start -= 1;
    }

    while (start > 0 && !/\s/.test(characters[start - 1])) {
      start -= 1;
    }
  }

  return {
    characters: [...characters.slice(0, start), ...characters.slice(cursor)],
    cursor: start
  };
}

function InputPrompt({ label, defaultValue, validate }) {
  const { exit } = useApp();
  const initialCharacters = Array.from(defaultValue);
  const initialEditor = {
    characters: initialCharacters,
    cursor: initialCharacters.length
  };
  const editorRef = useRef(initialEditor);
  const [editor, setEditor] = useState(initialEditor);
  const [error, setError] = useState('');

  function updateEditor(updater) {
    const nextEditor = typeof updater === 'function' ? updater(editorRef.current) : updater;
    editorRef.current = nextEditor;
    setEditor(nextEditor);
  }

  useInput((input, key) => {
    if (isKeyRelease(key)) {
      return;
    }

    if (isControlC(input, key) || key.escape) {
      exit(cancellation());
      return;
    }

    if (key.return) {
      try {
        const value = editorRef.current.characters.join('');
        exit(validate ? validate(value) : value);
      } catch (validationError) {
        setError(validationError.message);
      }
      return;
    }

    if (key.leftArrow) {
      updateEditor((current) => ({ ...current, cursor: Math.max(0, current.cursor - 1) }));
      return;
    }

    if (key.rightArrow) {
      updateEditor((current) => ({
        ...current,
        cursor: Math.min(current.characters.length, current.cursor + 1)
      }));
      return;
    }

    if (key.home || (key.ctrl && (input === 'a' || input === '\u0001'))) {
      updateEditor((current) => ({ ...current, cursor: 0 }));
      return;
    }

    if (key.end || (key.ctrl && (input === 'e' || input === '\u0005'))) {
      updateEditor((current) => ({ ...current, cursor: current.characters.length }));
      return;
    }

    if (key.backspace) {
      updateEditor((current) => removeBeforeCursor(current.characters, current.cursor));
      setError('');
      return;
    }

    if (key.delete) {
      updateEditor((current) => ({
        characters: [
          ...current.characters.slice(0, current.cursor),
          ...current.characters.slice(current.cursor + 1)
        ],
        cursor: current.cursor
      }));
      setError('');
      return;
    }

    if (key.ctrl && (input === 'u' || input === '\u0015')) {
      updateEditor((current) => ({
        characters: current.characters.slice(current.cursor),
        cursor: 0
      }));
      setError('');
      return;
    }

    if (key.ctrl && (input === 'k' || input === '\u000b')) {
      updateEditor((current) => ({
        characters: current.characters.slice(0, current.cursor),
        cursor: current.cursor
      }));
      setError('');
      return;
    }

    if (key.ctrl && (input === 'w' || input === '\u0017')) {
      updateEditor((current) => removeBeforeCursor(current.characters, current.cursor, 'word'));
      setError('');
      return;
    }

    if (key.ctrl || key.meta) {
      return;
    }

    const inserted = Array.from(input.replace(/[\u0000-\u001f\u007f]/g, ''));

    if (inserted.length > 0) {
      updateEditor((current) => ({
        characters: [
          ...current.characters.slice(0, current.cursor),
          ...inserted,
          ...current.characters.slice(current.cursor)
        ],
        cursor: current.cursor + inserted.length
      }));
      setError('');
    }
  });

  const beforeCursor = editor.characters.slice(0, editor.cursor).join('');
  const cursorCharacter = editor.characters[editor.cursor] || ' ';
  const afterCursor = editor.characters.slice(editor.cursor + 1).join('');

  return (
    <Box flexDirection="column">
      <Question>{label}</Question>
      <Box marginLeft={2}>
        <Text color={COLORS.accent}>› </Text>
        <Text>{beforeCursor}</Text>
        <Text backgroundColor={COLORS.accent} color="black">{cursorCharacter}</Text>
        <Text>{afterCursor}</Text>
      </Box>
      {error ? (
        <Text color={COLORS.danger}>{`  ${error}`}</Text>
      ) : (
        <Text dimColor>  enter save · ctrl-u clear · esc cancel</Text>
      )}
    </Box>
  );
}

function ProgressView({ name, progress }) {
  const { columns } = useWindowSize();
  const active = progress.phase === 'scanning' || progress.phase === 'metadata';
  const { frame } = useAnimation({ interval: 80, isActive: active });
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][frame % 10];

  if (progress.phase === 'scanning') {
    return <Text><Text color={COLORS.accent}>{spinner}</Text>{` Indexing ${name}…`}</Text>;
  }

  if (progress.phase === 'metadata') {
    return <Text><Text color={COLORS.accent}>{spinner}</Text>{` Finalizing ${name}…`}</Text>;
  }

  if (progress.phase === 'complete') {
    return <Text color={COLORS.success}>{`✓ Removed ${name}`}</Text>;
  }

  const ratio = progress.total === 0 ? 1 : Math.min(1, progress.completed / progress.total);
  const terminalWidth = Number.isFinite(columns) ? columns : 80;
  const barWidth = Math.max(8, Math.min(24, terminalWidth - name.length - 34));
  const filledWidth = Math.round(ratio * barWidth);
  const bar = `${'━'.repeat(filledWidth)}${'─'.repeat(barWidth - filledWidth)}`;
  const percent = String(Math.round(ratio * 100)).padStart(3);
  const count = `${progress.completed.toLocaleString('en-US')}/${progress.total.toLocaleString('en-US')}`;

  return (
    <Text>
      <Text color={COLORS.danger}>●</Text>
      {` Deleting ${name}  `}
      <Text color={COLORS.accent}>{bar}</Text>
      {`  ${percent}%  `}
      <Text dimColor>{count}</Text>
    </Text>
  );
}

function renderOptions(runtime, output, { alternateScreen = false } = {}) {
  return {
    stdin: runtime.stdin,
    stdout: output,
    stderr: output,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
    incrementalRendering: true,
    alternateScreen
  };
}

async function runInkPrompt(runtime, element, options = {}) {
  const output = promptOutput(runtime);
  const instance = render(element, renderOptions(runtime, output, options));

  try {
    return await instance.waitUntilExit();
  } finally {
    instance.cleanup();
  }
}

function createInkProgress(runtime, output, worktreePath) {
  const rawName = worktreePath.split(/[\\/]/).pop() || worktreePath;
  const name = rawName.length > 24 ? `${rawName.slice(0, 21)}…` : rawName;
  let progress = { phase: 'scanning', completed: 0, total: 0 };
  const instance = render(
    <ProgressView name={name} progress={progress} />,
    renderOptions(runtime, output)
  );
  let stopped = false;

  return {
    update(nextProgress) {
      if (stopped) {
        return;
      }

      progress = nextProgress;
      instance.rerender(<ProgressView name={name} progress={progress} />);
    },
    async stop() {
      if (stopped) {
        return;
      }

      stopped = true;
      await instance.waitUntilRenderFlush();
      instance.clear();
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
    }
  };
}

export function createPromptAdapter(runtime) {
  async function question(message, { output = promptOutput(runtime) } = {}) {
    const rl = readline.createInterface({
      input: runtime.stdin,
      output
    });

    try {
      return await rl.question(message);
    } finally {
      rl.close();
    }
  }

  return {
    async ask(label, { defaultValue = '', validate } = {}) {
      if (canUseInteractivePrompt(runtime)) {
        return runInkPrompt(runtime, (
          <InputPrompt label={label} defaultValue={defaultValue} validate={validate} />
        ));
      }

      while (true) {
        const defaultLabel = defaultValue ? ` (${defaultValue})` : '';
        const answer = (await question(`${label}${defaultLabel}: `)).trim();
        const value = answer || defaultValue;

        try {
          return validate ? validate(value) : value;
        } catch (error) {
          runtime.stderr.write(`${error.message}\n`);
        }
      }
    },

    async confirm(label, { defaultValue = false } = {}) {
      if (canUseInteractivePrompt(runtime)) {
        return runInkPrompt(runtime, (
          <ConfirmPrompt label={label} defaultValue={defaultValue} />
        ));
      }

      const suffix = defaultValue ? 'Y/n' : 'y/N';
      const answer = (await question(`${label} (${suffix}): `)).trim().toLowerCase();

      if (!answer) {
        return defaultValue;
      }

      return answer === 'y' || answer === 'yes';
    },

    async select(label, choices, { header } = {}) {
      if (choices.length === 0) {
        throw new Error('no choices available');
      }

      const output = promptOutput(runtime);

      if (canUseInteractivePrompt(runtime)) {
        return runInkPrompt(runtime, (
          <SelectPrompt label={label} choices={choices} header={header} />
        ), { alternateScreen: true });
      }

      output.write(`${label}\n`);
      if (header) {
        output.write(`  ${header}\n`);
      }

      choices.forEach((choice, index) => {
        output.write(`  ${index + 1}. ${choice.label}\n`);
      });

      while (true) {
        const answer = (await question('Select a number: ')).trim();
        const selectedIndex = Number.parseInt(answer, 10) - 1;

        if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < choices.length) {
          return choices[selectedIndex].value;
        }

        runtime.stderr.write('Enter a valid selection number.\n');
      }
    },

    async worktreeMenu(label, choices, options = {}) {
      if (choices.length === 0) {
        throw new Error('no choices available');
      }

      const output = promptOutput(runtime);
      const { header } = options;

      if (canUseInteractivePrompt(runtime)) {
        return runInkPrompt(runtime, (
          <WorktreeMenuPrompt
            label={label}
            choices={choices}
            header={header}
            updatePromise={options.updatePromise}
            mapUpdate={options.mapUpdate}
          />
        ), { alternateScreen: true });
      }

      Promise.resolve(options.updatePromise).catch(() => {});

      output.write(`${label}\n`);
      if (header) {
        output.write(`  ${header}\n`);
      }

      choices.forEach((choice, index) => {
        output.write(`  ${index + 1}. ${choice.label}\n`);
      });
      output.write('  f. Refresh PR status\n');
      output.write('  n. New worktree\n');
      output.write('  r. Remove first listed worktree\n');
      output.write('  c. Config\n');
      output.write('  q. Quit\n');

      while (true) {
        const answer = (await question('Select a number, f, n, r, c, or q: ')).trim().toLowerCase();

        if (!answer) {
          return { action: 'switch', value: choices[0].value };
        }

        if (['f', 'n', 'c', 'q'].includes(answer)) {
          const actions = { f: 'refresh', n: 'new', c: 'config', q: 'quit' };
          return { action: actions[answer] };
        }

        if (answer === 'r') {
          return { action: 'remove', value: choices[0].value };
        }

        const selectedIndex = Number.parseInt(answer, 10) - 1;

        if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < choices.length) {
          return { action: 'switch', value: choices[selectedIndex].value };
        }

        runtime.stderr.write('Enter a valid selection number or action.\n');
      }
    },

    createProgress(output, worktreePath) {
      if (!output?.isTTY) {
        return {
          update() {},
          async stop() {}
        };
      }

      return createInkProgress(runtime, output, worktreePath);
    }
  };
}
