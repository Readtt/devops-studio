# devops-studio-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _ds_user_zdotdir="${DEVOPS_STUDIO_USER_ZDOTDIR:-$HOME}"
  [ -f "$_ds_user_zdotdir/.zprofile" ] && source "$_ds_user_zdotdir/.zprofile"
  unset _ds_user_zdotdir
}
:
