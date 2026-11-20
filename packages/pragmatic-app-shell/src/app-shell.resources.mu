// app-shell.resources.mu - the views of the shell every Mural application shares.
//
// An application merges AppShellResources into its sign-in application and its shell (`merge AppShellResources`),
// so these implicit-by-type templates render the shell's view models wherever they appear: a ContentControl over
// the sign-in host's Page, the header's ContentControl over the session service, the DialogService surface, and a
// section's content host. A derived view model (a session service with a role label, a reveal page) keeps the base
// template unless the application supplies a more specific one.
//
// The sign-in page: the product name, Sign in (the OIDC redirect) and, for an application that offers it, the
// email + password form; both boxes are real browser inputs (UsesNativeInput), so password managers, IME and screen
// readers work. Enter-to-submit: a single-line TextBox leaves Return unhandled, so KeyDown bubbles to the form's
// StackPanel, whose AppShellSubmitOnEnter style (a Style is the only place `on <Event>` is allowed) invokes
// SubmitKeyCommand with the key args. Why the shell could not start shows above, with Try again.
//
// The header: who is signed in, Change password (when the application offers it), Log out, and what the last
// account action did, why access was refused, or why logout failed.
//
// The change-password dialog: current, new and confirm, all masked native password inputs; why Confirm is still off
// shows under the field at fault. The one-time-secret page: the value with Copy, the warning, "I've saved it", and
// the page's own confirm label.

import SignInPageViewModel from "./sign-in/sign-in-page-view-model.js"
import AppSessionService from "./session/app-session-service.js"
import ChangePasswordDialogViewModel from "./dialogs/change-password-dialog-view-model.js"
import OneTimeSecretPageViewModel from "./secrets/one-time-secret-page-view-model.js"

resources AppShellResources {
    Style x:key="AppShellSubmitOnEnter" [ TargetType = StackPanel ] {
        on KeyDown { InvokeCommand [ Command = $SubmitKeyCommand ] }
    }

    DataTemplate [ DataType = SignInPageViewModel ] {
        Border [ Fill = @Bg1 ] {
            Border [ Fill = @Bg0, Stroke = Pen [ Brush = @Border ], Padding = (24,24,24,24),
                     HorizontalAlignment = Center, VerticalAlignment = Center ] {
                StackPanel [ Orientation = Vertical, Style = @AppShellSubmitOnEnter ] {
                    TextBlock [ Text = $ProductName, Style = @H3, Foreground = @Fg0 ]
                    TextBlock [ Text = "Sign in to continue.", Style = @Body, Foreground = @Fg2, Margin = (0,4,0,16) ]
                    TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap,
                                Margin = (0,0,0,16), Visibility = $ErrorText << ToVisibility ]

                    StackPanel [ Orientation = Horizontal, Visibility = $OffersOidc << ToVisibility ] {
                        Button [ Variant = Filled, Command = $SignInCommand, Margin = (0,0,8,0) ] {
                            TextBlock [ Text = "Sign in" ]
                        }
                        Button [ Variant = Secondary, Command = $RetryCommand, Visibility = $ErrorText << ToVisibility ] {
                            TextBlock [ Text = "Try again" ]
                        }
                    }

                    TextBlock [ Text = "Or sign in with a password", Style = @UiCaption, Foreground = @Fg2,
                                Margin = (0,16,0,8), Visibility = $OffersBoth << ToVisibility ]

                    StackPanel [ Orientation = Vertical, Visibility = $OffersPassword << ToVisibility ] {
                        TextBlock [ Text = "Email", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ UsesNativeInput = true, InputPurpose = Email, Text = $Email, Placeholder = "Email",
                                  SubmitsOnEnter = true, Margin = (0,0,0,12) ]
                        TextBlock [ Text = "Password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
                        TextBox [ UsesNativeInput = true, InputPurpose = CurrentPassword, Text = $Password, Placeholder = "Password",
                                  IsPassword = true, SubmitsOnEnter = true, Margin = (0,0,0,16) ]
                        Button [ Variant = Secondary, Command = $PasswordSignInCommand, HorizontalAlignment = Left ] {
                            TextBlock [ Text = "Sign in with password" ]
                        }
                    }
                }
            }
        }
    }

    DataTemplate [ DataType = AppSessionService ] {
        Border [ Fill = @Bg0, Stroke = Pen [ Brush = @Border ], Padding = (16,8,16,8) ] {
            DockPanel {
                Button [ DockPanel.Dock = Right, Variant = Text, Command = $LogoutCommand, Margin = (12,0,0,0) ] {
                    TextBlock [ Text = "Log out" ]
                }
                Button [ DockPanel.Dock = Right, Variant = Text, Command = $ChangePasswordCommand, Margin = (12,0,0,0) ] {
                    TextBlock [ Text = "Change password" ]
                }
                TextBlock [ DockPanel.Dock = Right, Text = $Email, Style = @UiLabel, Foreground = @Fg0, VerticalAlignment = Center ]
                StackPanel [ Orientation = Horizontal, VerticalAlignment = Center ] {
                    TextBlock [ Text = $ProductName, Style = @UiLabel, Foreground = @Fg0, Margin = (0,0,16,0) ]
                    TextBlock [ Text = $AccountNotice, Style = @UiCaption, Foreground = @StateSuccessInk,
                                Margin = (0,0,16,0), Visibility = $AccountNotice << ToVisibility ]
                    TextBlock [ Text = $AccessNotice, Style = @UiCaption, Foreground = @StateWarningInk,
                                Margin = (0,0,16,0), Visibility = $AccessNotice << ToVisibility ]
                    TextBlock [ Text = $LogoutError, Style = @UiCaption, Foreground = @StateDangerInk,
                                Visibility = $LogoutError << ToVisibility ]
                }
            }
        }
    }

    DataTemplate [ DataType = ChangePasswordDialogViewModel ] {
        StackPanel [ Orientation = Vertical, Margin = (0,4,0,0) ] {
            TextBlock [ Text = "Your other sessions will be signed out. This one stays signed in.", TextWrapping = Wrap,
                        Foreground = @Fg1, Margin = (0,0,0,12) ]
            TextBlock [ Text = "Current password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            TextBox [ UsesNativeInput = true, InputPurpose = CurrentPassword, IsPassword = true, Text = $CurrentPassword, Margin = (0,0,0,12) ]
            TextBlock [ Text = "New password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            StackPanel [ Orientation = Vertical, Margin = (0,0,0,12) ] {
                TextBox [ UsesNativeInput = true, InputPurpose = NewPassword, IsPassword = true, Text = $NewPassword ]
                TextBlock [ Text = $NewPasswordText, Style = @UiCaption, Foreground = @StateDangerInk, Margin = (0,4,0,0),
                            Visibility = $NewPasswordText << ToVisibility ]
            }
            TextBlock [ Text = "Confirm new password", Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,4) ]
            StackPanel [ Orientation = Vertical, Margin = (0,0,0,12) ] {
                TextBox [ UsesNativeInput = true, InputPurpose = NewPassword, IsPassword = true, Text = $ConfirmPassword ]
                TextBlock [ Text = $MismatchText, Style = @UiCaption, Foreground = @StateDangerInk, Margin = (0,4,0,0),
                            Visibility = $MismatchText << ToVisibility ]
            }
            TextBlock [ Text = $ErrorText, Foreground = @StateDangerInk, TextWrapping = Wrap, Margin = (0,0,0,12),
                        Visibility = $ErrorText << ToVisibility ]
            StackPanel [ Orientation = Horizontal, HorizontalAlignment = Right ] {
                Button [ Variant = Secondary, Command = $CancelCommand, Margin = (0,0,8,0) ] {
                    TextBlock [ Text = "Cancel" ]
                }
                Button [ Variant = Primary, Command = $ConfirmCommand ] {
                    TextBlock [ Text = "Change password" ]
                }
            }
        }
    }

    DataTemplate [ DataType = OneTimeSecretPageViewModel ] {
        ScrollViewer [ HorizontalScrollEnabled = false ] {
            StackPanel [ Orientation = Vertical, Margin = (24,20,24,20) ] {
                TextBlock [ Text = $Title, Style = @H3, Foreground = @Fg0, Margin = (0,0,0,16) ]
                Border [ Fill = @StateWarningSoft, Padding = (12,10,12,10), Margin = (0,0,0,16) ] {
                    TextBlock [ Text = $Notice, Foreground = @StateWarningInk, TextWrapping = Wrap ]
                }
                Border [ Fill = @Bg1, Stroke = Pen [ Brush = @Border ], Padding = (12,10,12,10), Margin = (0,0,0,8) ] {
                    DockPanel {
                        Button [ DockPanel.Dock = Right, Variant = Secondary, Command = $CopyCommand, Margin = (12,0,0,0) ] {
                            TextBlock [ Text = "Copy" ]
                        }
                        TextBlock [ Text = $Value, Style = @Code, Foreground = @Fg0, VerticalAlignment = Center, TextWrapping = Wrap ]
                    }
                }
                TextBlock [ Text = $CopyStatus, Style = @UiCaption, Foreground = @Fg2, Margin = (0,0,0,12),
                            Visibility = $CopyStatus << ToVisibility ]
                StackPanel [ Orientation = Horizontal, Margin = (0,0,0,16) ] {
                    Checkbox [ IsChecked = $Saved, VerticalAlignment = Center, Margin = (0,0,8,0) ]
                    TextBlock [ Text = "I've saved it", Foreground = @Fg0, VerticalAlignment = Center ]
                }
                Button [ Variant = Primary, Command = $ConfirmSavedCommand, HorizontalAlignment = Left ] {
                    TextBlock [ Text = $ConfirmLabel ]
                }
            }
        }
    }
}
