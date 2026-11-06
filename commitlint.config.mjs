// Conventional Commits policy for this repository (same types as the parent
// proton-lfs-cli project). Used by .github/workflows/commits.yml; the local
// commit-msg hook in .pre-commit-config.yaml checks the same type list.
const PR_REF_SUFFIX = / \(#\d+\)$/;

export default {
  plugins: [
    {
      rules: {
        'header-max-length-without-pr-ref': ({ header }, when = 'always', max = 72) => {
          const length = (header ?? '').replace(PR_REF_SUFFIX, '').length;
          return [length <= max, `header must not be longer than ${max} characters (GitHub's " (#N)" suffix excluded), current length is ${length}`];
        },
      },
    },
  ],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'ci', 'perf', 'build'],
    ],
    'type-case': [2, 'always', 'lower-case'],
    'type-empty': [2, 'never'],
    'scope-case': [2, 'always', 'lower-case'],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    // "<type>(<scope>): <subject>" fits in 72 columns. GitHub appends
    // " (#<number>)" to squash-merged commits; that suffix is not counted.
    'header-max-length': [0],
    'header-max-length-without-pr-ref': [2, 'always', 72],
    'header-trim': [2, 'always'],
    'body-leading-blank': [2, 'always'],
    'footer-leading-blank': [2, 'always'],
  },
};
